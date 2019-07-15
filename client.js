const cTable = require('console.table');
const fetch = require('node-fetch');
const fs = require('fs');
const _getSize = require('get-folder-size');
const _parseXml = require('xml2js').parseString;
const prettyBytes = n => require('pretty-bytes')(Number(n));
const redis = require('redis');
const rimraf = require('rimraf');
const util = require('util');
const yerbamate = require('yerbamate');
const WebTorrent = require('webtorrent');
const mejortorrent = require('./mejortorrent');

const parseXml = util.promisify(_parseXml);
const getSize = util.promisify(_getSize);

const _localDownloadHistory = {};
let downloadHistory = {
    async contains(key) {
        return Boolean(_localDownloadHistory[key]);
    },
    async set(key, value) {
        return _localDownloadHistory[key] = value;
    }
};
let downloadQueue = [];

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

const torrentClient = new WebTorrent();
torrentClient.torrentsInProgress = () => torrentClient.torrents.filter(t => t.progress < 1);
const redisClient = redis.createClient(config.redisUrl);
const redisGetAsync = util.promisify(redisClient.get).bind(redisClient);
const redisKeysAsync = util.promisify(redisClient.keys).bind(redisClient);
const redisSetAsync = util.promisify(redisClient.set).bind(redisClient);


redisClient.on('error', () => console.log('Could not connect to redis, using memory history.'));
redisClient.on('connect', () => {
    console.log('Connected to redis. Using it as history.');
    downloadHistory = {
        async contains(key) {
            return (await redisKeysAsync(key)).length !== 0;
        },
        async set(key, value) {
            return redisClient.set(key, value);
        }
    }
});


const setIntervalAndInit = (f, t) => {
    f();
    return setInterval(f, t);
}


async function uploadToDrive(path, onComplete) {
    const rcloneCommand = `${config.rclonePath} copy ${path} ${config.rcloneRemote}`;
    console.log('Starting upload with: ', rcloneCommand);
    yerbamate.run(rcloneCommand, '', {}, (code, out, errs) => {
        console.log(`rclone out:\n  Code: ${code}\n  Out: ${out}\n\n  Error: ${errs}`);
        return onComplete();
    });
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
}


async function handleFeedItems(feedItems) {
    console.log(`Got ${feedItems.length} new items from feed`);
    downloadQueue = downloadQueue.concat(feedItems).sort((a,b) => a.pubDate > b.pubDate);
}

setIntervalAndInit(() => {
    console.log('------------------------------------------------');
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
            if (channel.item === undefined) channel.item = [];
            console.log(`${channel.item.length} items fetched from ${f.url}`);
            return channel.item.map(item => {
                const {
                    title,
                    size,
                    pubDate,
                    link,
                    enclosure
                } = item;
                return {
                    title: (title || []).pop(),
                    size: (size || ['-1']).pop(),
                    pubDate: new Date((pubDate || []).pop()),
                    link: encodeURI((link || ['']).pop())
                };
            });
        })
        .reduce((acc, el) => acc.concat(el), []);
        handleFeedItems(feedItems);
    });
    const mejorTorrentPreItems = await mejortorrent.scrape()
    const mejorTorrentItems = mejorTorrentPreItems.map(item => {
        return {
            title: item.title,
            size: -1,
            pubDate: 1,
            link: item.link,
            enclosure: ''
        }
    });
    handleFeedItems(mejorTorrentItems);
}, config.checkInterval * 1000);

const progressLoop = setInterval(() => {
    console.log('------------------------------------------------');
    console.log(`Download queue: ${downloadQueue.length}`);
    console.log(`Downloading: ${torrentClient.torrentsInProgress().length}`);
    console.table(torrentClient.torrentsInProgress().map(t => {
        return {
            Mame: t.name,
            Progress: `${((t.progress * 100).toFixed(2)).toString()}%`,
            DL: `${prettyBytes(t.downloadSpeed)}/s`,
            UL: `${prettyBytes(t.uploadSpeed)}/s`,
            Path: t.path
        }
    }));
    if (downloadQueue.length === 0 && torrentClient.torrentsInProgress().length === 0) {
        console.log('No more to download. Waiting...');
        return;
    }
}, 60000);

const queueLoop = setInterval(() => {
    console.log('------------------------------------------------');
    const currentDownloads = downloadQueue.slice(0, config.maxSimultaneousDownloads - torrentClient.torrentsInProgress().length);
    downloadQueue = downloadQueue.slice(config.maxSimultaneousDownloads - torrentClient.torrentsInProgress().length);
    currentDownloads.forEach(async item => {
        let magnet;
        if (item.link.startsWith('magnet:')) {
            magnet = item.link;
        } else {
            const res = await fetch(item.link, {redirect: 'manual'});
            magnet = res.headers.get('location');
        }
        if (magnet === null) {
            console.warn('Error fetching magnet:', item.link, res.status, res.headers, res);
            return;
        }
        if (await downloadHistory.contains(magnet)) {
            console.log('Skipping torrent because the magnet is in history:', item.title);
            return;
        } else {
            console.log(`Adding magnet of '${item.title}' to history.`);
            await downloadHistory.set(magnet, 'magnet');
        }
        console.log('Adding new torrent:', item.title);

        torrentClient.add(magnet, torrent => {
            torrent.setMaxListeners(20);
            torrent.on('error', err => console.log('Error on torrent:', item.name));
            torrent.createdAt = Date.now();
            torrent.uploadedToDrive = null;
            torrent.downloadFinishedAt = null;
            torrent.initialCheckDone = false;
            torrent.feedItem = item;
            console.log(`\nNew torrent: \n  Title: ${item.title}\n  Download path: ${torrent.path}\n  Size: ${prettyBytes(item.size)}\n  Files:${torrent.files.reduce((a, f) => a + `\n    ${f.name}` , '')}`);

            const checkerLoop = setInterval(async () => {
                console.log('------------------------------------------------');
                if (!torrent.initialCheckDone) {
                    torrent.initialCheckDone = true;
                    if (await downloadHistory.contains(torrent.infoHash)) {
                        return removeTorrent(torrent, item, 'already downloaded (seen in history) (size is wrong -->)', afterRemove([checkerLoop]));
                    } else {
                        await downloadHistory.set(magnet, 'magnet');
                        await downloadHistory.set(torrent.infoHash, 'infoHash');
                        console.log('Torrent hash not found in history, adding:', item.title);
                    }
                }

                if (torrent.uploadedToDrive === null) {
                    torrent.uploadedToDrive = await isFolderInDrive(torrent.name);
                    if (torrent.uploadedToDrive) {
                        await downloadHistory.set(magnet, 'magnet');
                        await downloadHistory.set(torrent.infoHash, 'infoHash');
                        return removeTorrent(torrent, item, 'already downloaded (seen in Drive, not added to history) (size is wrong -->)', afterRemove([checkerLoop]));
                    } else console.log(`${item.title} not found in Drive. Download continues.`)
                }

                if (torrent.progress !== 1 && torrent.downloadSpeed < config.minDownloadThresholdBytesPerSecond) {
                    const inactiveSeconds = (Date.now() - torrent.createdAt) / 1000;
                    if (inactiveSeconds > config.maxOldnessSecondsWithoutPeers)
                        return removeTorrent(torrent, item, 'max time without peers reached', afterRemove([checkerLoop]));
                    else
                        console.log(`${item.title} is running slow. It'll be deleted in ${config.maxOldnessSecondsWithoutPeers - inactiveSeconds}s.`)
                }

                if (torrent.progress === 1) {
                    let toDelete = false;
                    if (torrent.uploadedToDrive) {
                        if (torrent.uploaded / torrent.downloaded > config.maxRatio) {
                            toDelete = true;
                            removeTorrent(torrent, item, 'ratio reached', afterRemove([checkerLoop]));
                        } else if (torrent.downloadFinishedAt !== null && (Date.now() - torrent.downloadFinishedAt)/1000 > config.maxOldnessSecondsSeeding) {
                            toDelete = true;
                            removeTorrent(torrent, item, 'max time seeding reached', afterRemove([checkerLoop]));
                        }
                    }

                    if (!toDelete) {
                        console.log(`${item.title} will not be deleted for now`);
                    }
                }
            }, 60000);

            torrent.on('done', () => {
                torrent.downloadFinishedAt = Date.now();
                uploadToDrive(torrent.path, () => {
                    console.log('Upload complete:', item.title);
                    torrent.uploadedToDrive = true;
                });
            })
        })
    });
}, 10000);


torrentClient.on('error', err => {
    afterRemove(['queueLoop', 'progressLoop', 'checkerLoop']);  // Stop loops
    redisClient.quit();
    console.error('Fatal error on client:', err);
});
