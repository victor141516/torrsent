const { URLSearchParams } = require('url')
const Bottleneck = require("bottleneck/es5")
const cheerio = require('cheerio')
const fetch = require('node-fetch')
const parseTorrent = require('parse-torrent')

const baseUrl = 'http://www.mejortorrentt.org/'
const mainUrl = 'http://www.mejortorrentt.org/'
const limiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: 2000
})
const slowFetch = limiter.wrap(fetch);


async function getMainPageLinks() {
    console.debug('Getting main page')
    const html = await slowFetch(mainUrl).then(res => res.text())
    const $ = cheerio.load(html)
    const linkElements = $('#main_table_center_center2 > table.main_table_center_content div > a')
    const links = []
    linkElements.each((i, e) => links.push(`${baseUrl}${e.attribs.href}`))
    console.debug(`${links.length} items extracted`)
    return links
}

function isTvShow(html) {
    return html.includes('Marcar/Desmarcar Todos')
}

async function scrapEachItem(url) {
    const slug = url.split('.html')[0].split('/').pop()
    console.debug(`Getting ${slug}`)
    const baseDownloadUrl = `${baseUrl}uploads/torrents/`
    const summaryDownloadRegex = /<a href='(.+)' style='font-size:12px;'>Descargar<\/a>/
    const onclickFunctionRegex = /post\('(.+), \{table: '(.+)', name: '(.+)'\}\)/
    const summaryHtml = await slowFetch(url).then(res => res.text())

    if (isTvShow(summaryHtml)) {
        console.debug(`[${slug}] - Is TV show`)
        const $ = cheerio.load(summaryHtml)
        const episodeCheckboxes = $('#main_table_center_center1 input[type=checkbox][name^=episodios]')
        const episodeIds = []
        episodeCheckboxes.each((i, e) => episodeIds.push(e.attribs.value))
        console.debug(`[${slug}] - ${episodeIds.length} episodes:`, episodeIds)

        const params = new URLSearchParams();
        episodeIds.forEach((e, i) => params.append(`episodios[${i+1}]`, e))
        params.append('checkall', 'on');
        params.append('total_capis', episodeIds.length);
        params.append('tabla', 'series');
        const title = $('input[type=hidden][name=titulo]').attr('value')
        console.debug(`[${slug}] - Title: ${title}`)
        params.append('titulo', title);
        const downloadUrl = `${baseUrl}secciones.php?sec=descargas&ap=contar_varios`

        const downloadHtml = await slowFetch(downloadUrl, {
            method: 'POST',
            body: params
        }).then(res => res.text())
        const $$ = cheerio.load(downloadHtml)

        const titles = []
        $$('#main_table_center_center1 td > a[href=\'#\']').each((i, e) => titles.push(e.attribs.title))
        console.debug(`[${slug}] - ${titles.length} titles:`, titles)

        const magnets = await Promise.all(titles.map(async (title) => {
            const episodeDownloadUrl = `${baseDownloadUrl}series/${title}`
            const torrentFile = await slowFetch(episodeDownloadUrl).then(res => res.buffer())
            const magnet = parseTorrent.toMagnetURI(parseTorrent(torrentFile))
            console.debug(`[${slug}] - New magnet:`, magnet)
            return {title, link: magnet}
        }))
        return magnets
    } else {
        console.debug(`[${slug}] - Is not TV show`)
        const downloadLink = `${baseUrl}${summaryHtml.match(summaryDownloadRegex)[1]}`
        const downloadHtml = await slowFetch(downloadLink).then(res => res.text())
        const $ = cheerio.load(downloadHtml)
        const onclick = $('#main_table_center_center1 td > a[href=\'#\']').attr('onclick')
        const [all, postPath, table, name] = onclick.match(onclickFunctionRegex)
        console.debug(`[${slug}] - Name: ${name}`)
        const torrentFile = await slowFetch(`${baseDownloadUrl}${table}/${name}`).then(res => res.buffer())
        const magnet = parseTorrent.toMagnetURI(parseTorrent(torrentFile))
        console.debug(`[${slug}] - Magnet: ${magnet}`)
        return [{title: name, link: magnet}]
    }
}


async function scrape() {
    const links = await getMainPageLinks()
    const eachMagnets = await Promise.all(links.map(async (l) => {
        const magnets = await scrapEachItem(l)
        return magnets
    }))
    const magnets = eachMagnets.reduce((acc, e) => acc.concat(e), [])
    return magnets

}

module.exports = {
    scrape
}
