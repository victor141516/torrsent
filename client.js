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

const downloadHistory = {};
let downloadQueue = [];
let downloadingItems = 0;

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
    console.log(`Config:${Object.keys(config).reduce((a, k) => a + `\n  ${k}: ${config[k]}` , '')}`);
} catch (error) {
    console.error('Invalid config file');
    process.exitCode = 1;
}

const client = new WebTorrent()


const setIntervalAndInit = (f, t) => {
    f();
    return setInterval(f, t);
}


async function uploadToDrive(path, onComplete) {
    const rcloneCommand = `${config.rclonePath} copy ${path} ${config.rcloneRemote}`;
    console.log('Starting upload with: ', rcloneCommand);
    yerbamate.run(rcloneCommand, '', {}, onComplete);
}


function isFolderInDrive(folderName) {
    const rcloneCommand = `${config.rclonePath} lsd ${config.rcloneRemote}`;
    return new Promise((res) => {
        yerbamate.run(rcloneCommand, '', {}, (code, out, errs) => {
            const folders = out.map(l => l.split('-1').slice(2).join('-1').slice(1));
            console.log(`Looking for '${folderName} in Drive.`);
            res(folders.includes(folderName));
        });
    })
}


function removeTorrent(torrent, item, reason, onDelete) {
    torrent.destroy(() =>
        rimraf(torrent.path, () => {
            console.log(`${item.title} deleted by ${reason} (${prettyBytes(item.size)})`);
            if (onDelete) onDelete();
        }));
}


function afterRemove(loopsToClear) {
    loopsToClear.forEach(clearInterval);
    downloadingItems -= 1;
}


async function handleFeedItems(feedItems) {
    console.log(`Got ${feedItems.length} new items from feed`);
    downloadQueue = downloadQueue.concat(feedItems);
}

setIntervalAndInit(() => {
    const maxItemsInQueueForFetching = 10;
    if (downloadQueue.length > maxItemsInQueueForFetching) {
        console.log(`${downloadQueue.length} items in queue, fetching new items was skipped (max items for fetching ${maxItemsInQueueForFetching})`);
        return;
    }
    console.log('Fetching new items from feeds...');
    feeds.forEach(async f => {
        console.log('Fetching from:', f.url);
        const res = await fetch(f.url);
        const xmlBody = await res.text();
        const xml = await parseXml(xmlBody);
        const feedItems = xml.rss.channel.map(channel => {
            console.log(`${channel.item.length} items fetched from ${f.url}`);
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
}, config.checkInterval * 1000);

const queueLoop = setInterval(() => {
    console.log(`Download queue: ${downloadQueue.length}`);
    console.log(`Downloading: ${downloadingItems}`);
    if (downloadQueue.length === 0 && downloadingItems === 0) {
        console.log('No more to download. Waiting...');
        return;
    }
    const currentDownloads = downloadQueue.slice(0, config.maxSimultaneousDownloads - downloadingItems);
    downloadQueue = downloadQueue.slice(config.maxSimultaneousDownloads - downloadingItems);
    currentDownloads.forEach(async item => {
        const res = await fetch(item.link, {redirect: 'manual'});
        const magnet = res.headers.get('location');
        if (downloadHistory[magnet]) return;
        downloadingItems += 1;
        console.log('Adding new torrent:', item.title);

        client.add(magnet, torrent => {
            torrent.on('error', err => console.log('Error on torrent:', item.name));
            torrent.createdAt = Date.now();
            torrent.uploadedToDrive = false;
            torrent.downloadFinishedAt = null;
            console.log(`\nNew torrent: \n  Title: ${item.title}\n  Download path: ${torrent.path}\n  Size: ${prettyBytes(item.size)}\n  Files:${torrent.files.reduce((a, f) => a + `\n    ${f.name}` , '')}`);
            // client.seed(torrent.path);

            const progressLoop = setInterval(() => {
                const percent = ((torrent.progress * 100).toFixed(2)).toString();
                console.log(`Progress of ${item.title}: ${percent} % | DL @ ${prettyBytes(torrent.downloadSpeed)}/s | UL @ ${prettyBytes(torrent.uploadSpeed)}/s`);
            }, 10000);

            const checkerLoop = setInterval(async () => {
                if (await isFolderInDrive(torrent.name)) {
                    downloadHistory[torrent.infoHash] = 'infoHash';
                    return removeTorrent(torrent, item, 'already downloaded (seen in Drive, adding to history) (size is wrong -->)', afterRemove([checkerLoop, progressLoop]));
                }

                if (torrent.downloadSpeed === 0 && Date.now() - torrent.createdAt > config.maxOldnessSecondsWithoutPeers)
                    return removeTorrent(torrent, item, 'max time without peers reached', afterRemove([checkerLoop, progressLoop]));

                if (torrent.progress === 1 && torrent.uploadedToDrive) {
                    let toDelete = false;
                    if (torrent.uploaded / torrent.downloaded > config.maxRatio) {
                        toDelete = true;
                        removeTorrent(torrent, item, 'ratio reached', afterRemove([checkerLoop, progressLoop]));
                    } else if (torrent.downloadFinishedAt !== null && Date.now() - torrent.downloadFinishedAt > config.maxOldnessSecondsSeeding) {
                        toDelete = true;
                        removeTorrent(torrent, item, 'max time seeding reached', afterRemove([checkerLoop, progressLoop]));
                    }

                    if (!toDelete) {
                        console.log(`${item.title} will not be deleted for now`);
                    }
                }
            }, 10000);

            torrent.on('infoHash', () => {
                 if (downloadHistory[torrent.infoHash] && torrent.progress === 1)
                    removeTorrent(torrent, item, 'already downloaded (seen in history) (size is wrong -->)', afterRemove([checkerLoop, progressLoop]));
                else downloadHistory[torrent.infoHash] = 'infoHash';
            });

            torrent.on('done', () => {
                torrent.downloadFinishedAt = Date.now();
                downloadHistory[item.link] = 'magnet-downloaded'
                uploadToDrive(torrent.path, () => {
                    console.log('Upload complete:', item.title);
                    torrent.uploadedToDrive = true;
                });
            })
        })
    });
}, 10000);


client.on('error', err => {
    // End feed loop
    console.error('Fatal error on client:', err);
});
