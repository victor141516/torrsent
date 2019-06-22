const fetch = require('node-fetch');
const fs = require('fs');
const _getSize = require('get-folder-size');
const _parseXml = require('xml2js').parseString;
const prettyBytes = require('pretty-bytes');
const rimraf = require('rimraf');
const util = require('util');
const yerbamate = require('yerbamate');
const WebTorrent = require('webtorrent');

const parseXml = util.promisify(_parseXml);
const getSize = util.promisify(_getSize);
const client = new WebTorrent()


let feeds;
try {
    feeds = JSON.parse(fs.readFileSync('./feeds.json'));
} catch (error) {
    console.error('Invalid feeds file');
    process.exitCode = 1;
}

let config;
try {
    config = JSON.parse(fs.readFileSync('./config.json'));
} catch (error) {
    console.error('Invalid config file');
    process.exitCode = 1;
}


async function uploadToDrive(path, onComplete) {
    const rcloneCommand = `${config.rclonePath} copy ${path} ${config.rcloneRemote}`;
    console.log('Starting upload with: ', rcloneCommand);
    yerbamate.run(rcloneCommand, '', {}, onComplete);
}

async function cleanupDownloads(downloadPath, torrentClient) {
    console.log('Cleanup begins...');
    const allDownloads = fs.readdirSync(downloadPath).map(async f => {
        const path = `${downloadPath}/${f}`;
        return {
            directoryName: f,
            date: fs.lstatSync(path).ctimeMs,
            size: await getSize(path),
            torrent: torrentClient.torrents.find(t => t.path === path)
        };
    });
    const totalSize = allDownloads.reduce(async (a, e) => await a + (await e).size, 0);
    console.log('Download folder size:', prettyBytes(await totalSize));
    console.log('Listing torrents to delete...')

    const deletedBytes = allDownloads
        .reduce(async (a, e) => {
            const elem = await e;
            const path = `${downloadPath}/${elem.directoryName}`;
            const ratio = elem.torrent.uploaded / elem.torrent.downloaded;
            const time = (Date.now() - elem.date) / 1000;
            const canDeleteByRatio = ratio > config.maxRatio;
            const canDeleteByDate = time > config.maxOldnessSeconds;
            if (canDeleteByDate || canDeleteByRatio) {
                elem.torrent.destroy(() => {
                    rimraf(path, () => console.log(`${path} deleted`));
                })
                return await a + elem.size;
            } else return await a;
        }, 0);

    console.log(`${prettyBytes(await deletedBytes)} being deleted deleted`)
}


async function handleFeedItems(feedItems) {
    // feedItems.forEach(async item => {
    [feedItems[0], feedItems[1]].forEach(async item => {
        // const item = feedItems[0]
        const res = await fetch(item.link, {redirect: 'manual'});
        const magnet = res.headers.get('location');
        client.add(magnet, torrent => {
            console.log(`\nNew torrent: \n  Title: ${item.title}\n  Download path: ${torrent.path}\n  Size: ${prettyBytes(Number(item.size))}`);
            torrent.on('download', () => {
                if (Math.random() > 0.99999) return;
                const percent = ((torrent.progress * 100).toFixed(2)).toString();
                console.log(`Progress of ${item.title}: ${percent} %`);
            });
            torrent.on('done', () => {
                uploadToDrive(torrent.path, () => {
                    cleanupDownloads(torrent.path.split('/').slice(0, -1).join('/'), client);
                    console.log('Upload complete:', item.title);
                });
            })
        })
    })
}


feeds.forEach(async f => {
    const res = await fetch(f.url);
    const xmlBody = await res.text();
    const xml = await parseXml(xmlBody);
    const feedItems = xml.rss.channel.map(channel => {
        return channel.item.map(item => {
            const {
                title,
                size,
                link,
                enclosure,
                pubDate
            } = item;
            return {
                title: (title || []).pop(),
                size: (size || []).pop(),
                link: (link || []).pop(),
                // enclosure: ((enclosure || []).pop() || {})['$'],
                pubDate: (pubDate || []).pop()
            };
        })
    }).reduce((acc, el) => acc.concat(el), []);
    handleFeedItems(feedItems);
});
