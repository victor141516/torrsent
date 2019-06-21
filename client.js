const fetch = require("node-fetch");
const fs = require('fs');
const _parseXml = require('xml2js').parseString;
const util = require('util');
const yerbamate = require('yerbamate');
const WebTorrent = require('webtorrent');

const parseXml = util.promisify(_parseXml);
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


async function handleFeedItems(feedItems) {
    // feedItems.forEach(async item => {
        const item = feedItems[0]
        const res = await fetch(item.link, {redirect: 'manual'});
        const magnet = res.headers.get('location');
        client.add(magnet, torrent => {
            console.log(`New torrent: \n  Title: ${item.title}\n  Download path: ${torrent.path}`);
            torrent.on('download', () => {
                const percent = ((torrent.progress*100).toFixed(2)).toString();
                process.stdout.clearLine();
                process.stdout.cursorTo(0);
                process.stdout.write(`Progress: ${percent} %`);
            });
            torrent.on('done', () => {
                uploadToDrive(torrent.path, () => console.log('Upload complete:', item.title));
            })
        })
    // })
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


// const torrentId = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent'

// client.add(torrentId, function (torrent) {
//     const file = torrent.files.find(function (file) {
//         return file.name.endsWith('.mp4')
//     })
//     file.appendTo('body')
// })
