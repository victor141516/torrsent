const fetch = require('node-fetch');
const fs = require('fs');
const _getSize = require('get-folder-size');
const _parseXml = require('xml2js').parseString;
const prettyBytes = n => require('pretty-bytes')(Number(n));
const rimraf = require('rimraf');
const util = require('util');
const yerbamate = require('yerbamate');
const WebTorrent = require('webtorrent');

const parseXml = util.promisify(_parseXml);
const getSize = util.promisify(_getSize);
const client = new WebTorrent()

const downloadingItems = {};

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


function removeTorrent(torrent, item, reason, onDelete) {
    torrent.destroy(() =>
        rimraf(torrent.path, () => {
            console.log(`${item.title} deleted by ${reason} (${prettyBytes(item.size)})`);
            if (onDelete) onDelete();
        }));
}


async function handleFeedItems(feedItems) {
    // feedItems.forEach(async item => {
    [feedItems[0], feedItems[1]].forEach(async item => {
        const res = await fetch(item.link, {redirect: 'manual'});
        const magnet = res.headers.get('location');
        if (downloadingItems[magnet]) return;

        client.add(magnet, torrent => {
            torrent.createdAt = Date.now();
            torrent.downloadFinishedAt = null;
            torrent.on('ready', () => client.seed(torrent.path));
            torrent.on('error', err => console.log('Error on torrent:', item.name));
            console.log(`\nNew torrent: \n  Title: ${item.title}\n  Download path: ${torrent.path}\n  Size: ${prettyBytes(item.size)}`);

            const checkerLoop = setInterval(() => {
                const percent = ((torrent.progress * 100).toFixed(2)).toString();
                console.log(`Progress of ${item.title}: ${percent} % | DL @ ${prettyBytes(torrent.downloadSpeed)}/s`);

                if (torrent.uploaded / torrent.downloaded > config.maxRatio)
                    removeTorrent(torrent, item, 'ratio reached', () => clearInterval(checkerLoop));

                if (torrent.numPeers === 0 && Date.now() - torrent.createdAt > config.maxOldnessSecondsWithoutPeers)
                    removeTorrent(torrent, item, 'max time without peers reached', () => clearInterval(checkerLoop));

                if (torrent.downloadFinishedAt !== null && Date.now() - torrent.downloadFinishedAt > config.maxOldnessSecondsSeeding)
                    removeTorrent(torrent, item, 'max time seeding reached', () => clearInterval(checkerLoop));
            }, 5000);

            torrent.on('infoHash', () => {
                if (downloadingItems[torrent.infoHash] && torrent.progress === 1)
                    removeTorrent(torrent, item, 'already downloaded (size is wrong -->)', () => clearInterval(checkerLoop));
                else downloadingItems[torrent.infoHash] = 'infoHash';
            });

            torrent.on('done', () => {
                torrent.downloadFinishedAt = Date.now();
                downloadingItems[magnet] = 'magnet'
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


client.on('error', err => {
    // End feed loop
    console.error('Fatal error on client:', err);
});
