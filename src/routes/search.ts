// 路由模块:全局搜索(主程序标准音源接口)
// 端点:POST /api/search
//
// 与 WebDAV 插件不同,OpenList 提供 fs/search 服务端索引搜索,
// 因此这里聚合所有已配置服务器的搜索结果(真实搜索)。

import { createSearchHandler, jsonResponse } from '@songloft/plugin-sdk'
import type { Router, SearchResultItem } from '@songloft/plugin-sdk'
import { getConfigs, getConfig } from '../config'
import { searchFiles, walkSearchFiles } from '../services/openlist-client'
import { buildPublicStreamUrl } from '../services/stream'
import { isAudioFile, stripExtension } from '../types'
import type { OpenListConfig, OpenListFileItem } from '../types'
import { parseBody } from './configs'

const MAX_RESULTS_PER_SERVER = 50

/** 解析 "歌手 - 歌名" 文件名,否则歌名即全部文件名 */
function parseTrackName(baseName: string): { title: string; artist: string } {
  const m = baseName.match(/^(.+?)\s*-\s*(.+)$/)
  if (m) return { artist: m[1].trim(), title: m[2].trim() }
  return { artist: '', title: baseName }
}

/**
 * 单服务器搜歌:优先 fs/search 服务端索引;失败或未命中音频时兜底走
 * fs/list 递归遍历。OpenList 服务端默认不启用搜索索引("none"),
 * 此时 fs/search 报错,兜底保证未建索引的服务器也能搜到歌。
 */
async function searchAudioFiles(
  config: OpenListConfig,
  keyword: string,
  page: number,
  perServer: number,
): Promise<OpenListFileItem[]> {
  let items: OpenListFileItem[] = []
  try {
    items = await searchFiles(config, keyword, page, perServer)
  } catch (e) {
    songloft.log.warn(`[OpenList] fs/search unavailable on ${config.name} (${String((e as Error)?.message || e)}), fallback to walk search`)
  }
  if (!items.some(i => !i.isDir && isAudioFile(i.name))) {
    try {
      const walked = await walkSearchFiles(config, keyword)
      if (walked.length > 0) items = walked
    } catch (e) {
      songloft.log.warn(`[OpenList] walk search failed on ${config.name}: ${String((e as Error)?.message || e)}`)
    }
  }
  return items
}

export function mountSearchRoutes(router: Router): void {
  router.post('/api/search', createSearchHandler({
    search: async (keyword, page, pageSize) => {
      const configs = await getConfigs()
      if (configs.length === 0) return []

      const perServer = Math.min(pageSize || MAX_RESULTS_PER_SERVER, MAX_RESULTS_PER_SERVER)

      // 各服务器并行搜索,单台失败不影响整体(内部含遍历兜底)
      const settled = await Promise.allSettled(
        configs.map(config => searchAudioFiles(config, keyword, page || 1, perServer).then(items => ({ config, items })))
      )

      const results: SearchResultItem[] = []
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i]
        if (r.status === 'rejected') {
          songloft.log.warn(`[OpenList] search failed on ${configs[i].name}: ${String((r.reason as Error)?.message || r.reason)}`)
          continue
        }
        const { config, items } = r.value
        for (const item of items) {
          if (item.isDir || !isAudioFile(item.name)) continue
          const meta = parseTrackName(stripExtension(item.name))
          results.push({
            title: meta.title,
            artist: meta.artist || config.name, // 无歌手信息时用服务器名作来源标识
            duration: 0,
            source_data: { configName: config.name, path: item.path },
          })
        }
      }
      return results
    },
  }))

  // POST /api/search/topone — 搜索并返回单首可播候选(双轨制)
  // 供 MIoT 等插件在本地索引找不到歌曲时调用。结果同时携带:
  // - url:本插件自实现的 /stream/:token 稳定直链(访问时才实时解析 302,永不过期),
  //   MIoT 开 external_search_no_import 时据此「不入库直推」;推导不出音箱可达地址时置空。
  // - source_data:解析型兜底。未开 no_import 时入库,播放由宿主回调 /api/music/url 实时解析。
  router.post('/api/search/topone', async (req) => {
    const body = parseBody(req)
    const keyword = String(body.keyword || '').trim()
    const hint: { title?: string; artist?: string; duration?: number } | undefined = body.hint

    if (!keyword) return jsonResponse({ code: 400, msg: '缺少 keyword', data: null }, 400)

    const configs = await getConfigs()
    const notFound = {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 404, msg: 'song not found', data: null }),
    }
    if (configs.length === 0) return notFound

    // 跨所有 OpenList 服务器并行搜索(优先服务端索引,兜底目录遍历)
    interface Candidate { score: number; title: string; artist: string; configName: string; path: string }
    const allCandidates: Candidate[] = []
    const lowCandidates: Candidate[] = []
    const searchResults = await Promise.allSettled(
      configs.map(async (config) => {
        try {
          const items = await searchAudioFiles(config, keyword, 1, 20)
          return { configName: config.name, items }
        } catch (e) {
          songloft.log.warn(`[OpenList] topone search failed on ${config.name}: ${String((e as Error)?.message || e)}`)
          return null
        }
      }),
    )

    const hintTitle = (hint?.title || '').toLowerCase()
    const hintArtist = (hint?.artist || '').toLowerCase()
    for (const result of searchResults) {
      if (result.status !== 'fulfilled' || !result.value) continue
      const { configName, items } = result.value
      for (const item of items) {
        if (item.isDir || !isAudioFile(item.name)) continue
        const meta = parseTrackName(stripExtension(item.name))
        if (!meta.title) continue

        // 评分逻辑:hint 的 title/artist 匹配度(大小写不敏感)
        let score = 0
        const title = meta.title.toLowerCase()
        const artist = meta.artist.toLowerCase()
        if (hint) {
          if (hintTitle) {
            if (title === hintTitle) score += 0.5
            else if (title.includes(hintTitle) || hintTitle.includes(title)) score += 0.3
          }
          if (hintArtist) {
            if (artist === hintArtist) score += 0.3
            else if (artist && (artist.includes(hintArtist) || hintArtist.includes(artist))) score += 0.15
          }
        } else {
          // 无 hint 时给基础分,保证能返回
          score = 1
        }

        if (score < 0.4) {
          // 低分候选仅作回退保留:hint 全部未命中时,关键词命中的歌仍优于直接 404
          lowCandidates.push({ score, title: meta.title, artist: meta.artist, configName, path: item.path })
          continue
        }
        allCandidates.push({ score, title: meta.title, artist: meta.artist, configName, path: item.path })
      }
    }

    // hint 全部未达线时回退关键词命中的低分候选(服务端已按关键词过滤)
    if (allCandidates.length === 0 && lowCandidates.length > 0) {
      songloft.log.info(`[OpenList] topone no strong hint match, fallback to ${lowCandidates.length} keyword candidate(s)`)
      allCandidates.push(...lowCandidates)
    }

    if (allCandidates.length === 0) return notFound

    // 按评分降序,返回第一个配置仍然存在的候选。
    // url 指向本插件 /stream/:token(每次访问实时解析,非快照),入库持久化也安全。
    allCandidates.sort((a, b) => b.score - a.score)
    for (const c of allCandidates) {
      const config = await getConfig(c.configName)
      if (!config) continue
      const lyric = `/api/v1/jsplugin/openlist/api/lyric?configName=${encodeURIComponent(c.configName)}&path=${encodeURIComponent(c.path)}`
      const directUrl = await buildPublicStreamUrl({ configName: c.configName, path: c.path })
      songloft.log.info(`[OpenList] topone hit: "${c.title}" url=${directUrl || '(empty → 回退入库)'}`)
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            title: c.title,
            artist: c.artist,
            album: '',
            duration: 0,
            url: directUrl,
            plugin_entry_path: 'openlist',
            source_data: { configName: c.configName, path: c.path },
            dedup_key: `openlist_${c.configName}_${c.path}`,
            lyric,
            lyric_source: 'url',
          },
        }),
      }
    }

    return notFound
  })
}
