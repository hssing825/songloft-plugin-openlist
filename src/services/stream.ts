// 播放直链组装 — 把 source_data(configName + path)解析成可播放 URL
//
// 策略:
// 1. fs/get 返回的 raw_url 指向 OpenList 服务器自身(代理/本地路径,
//    如 /p/ 或 DownProxyURL)→ 稳定链接,直接使用
// 2. raw_url 指向第三方网盘 CDN → 是调用时刻的一次性快照,可能很快过期
//    (暂停久了/切后台恢复时失效),弃用,改走下载路由实时解析
// 3. 其余情况(含 raw_url 为空)统一回退到 OpenList 下载路由
//    /d/<path>?sign=<sign>:每次请求重新解析新直链并 302,不受快照过期影响
// 无论哪种方式都保留 sign 签名参数,避免开启 sign_all 的服务器拒绝访问。

import type { OpenListConfig } from '../types'
import { getPublicHost } from '../config'
import { getFile } from './openlist-client'

export interface StreamRequest {
  url: string
  headers?: Record<string, string>
}

function encodePathSegments(path: string): string {
  return path.split('/').map(s => (s ? encodeURIComponent(s) : '')).join('/')
}

/** 取 URL 的 scheme://host[:port] 前缀,用于判断是否指向同一服务器 */
function originOf(url: string): string {
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i)
  return m ? m[0].toLowerCase() : ''
}

/**
 * 解析播放直链。失败抛错,由 createMusicUrlHandler 统一转成 404。
 * 返回 { url },headers 目前不需要(raw_url 通常自带 CDN 签名)。
 */
export async function buildStreamRequest(
  config: OpenListConfig,
  path: string,
): Promise<StreamRequest> {
  if (!path || !path.startsWith('/')) {
    throw new Error('Invalid OpenList file path')
  }

  const info = await getFile(config, path)
  const base = config.url.replace(/\/+$/, '')

  if (info.rawUrl) {
    let url = info.rawUrl
    // 个别驱动返回相对路径,补全为服务器绝对地址
    if (url.startsWith('/')) {
      url = base + url
    }
    // 指向 OpenList 服务器自身的链接(代理/本地)是稳定的,直接使用
    if (originOf(url) === originOf(config.url)) {
      if (info.sign && !/[?&]sign=/.test(url)) {
        url += (url.includes('?') ? '&' : '?') + `sign=${encodeURIComponent(info.sign)}`
      }
      return { url }
    }
    // 第三方 CDN 直链是快照,可能已过期 → 落入下方 /d 路由实时解析
  }

  // 下载路由:每次请求重新解析新直链,天然新鲜
  let url = `${base}/d${encodePathSegments(path)}`
  if (info.sign) {
    url += `?sign=${encodeURIComponent(info.sign)}`
  }
  return { url }
}

// ===== 对外流 token(供音箱直连的 /stream/:token 与 topone 直推) =====
//
// token = base64url(JSON{ configName, path })。token 本身无状态、永不过期,
// 每次访问 /stream/:token 才实时解析新直链并 302,因此这个 URL 可安全持久化。
// QuickJS 无 Buffer,用 TextEncoder/TextDecoder + btoa/atob 实现 UTF-8 安全编解码。

export interface StreamTokenData {
  configName: string
  path: string
}

export function encodeStreamToken(data: StreamTokenData): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data))
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeStreamToken(token: string): StreamTokenData {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const data = JSON.parse(new TextDecoder('utf-8').decode(bytes))
  if (!data || typeof data.configName !== 'string' || typeof data.path !== 'string') {
    throw new Error('invalid stream token payload')
  }
  return data as StreamTokenData
}

function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(:|\/|$)/i.test(url)
}

/**
 * 构造音箱可直连的对外流 URL(指向本插件 /stream/:token,publicPaths 免鉴权)。
 * 对外地址推导优先级:手动配置的 publicHost → 宿主地址非回环 → 网卡 LAN 地址。
 * Docker 部署时后两者均不可用(容器网卡 172.x 被宿主过滤),必须配置 publicHost。
 * 推导不出音箱可达地址时返回空串 → 上层置空 url,回退入库播放。
 */
export async function buildPublicStreamUrl(data: StreamTokenData): Promise<string> {
  try {
    // 1. 手动配置的对外地址优先(最可靠,可覆盖 Docker/反代场景)
    const publicHost = await getPublicHost()
    if (publicHost && !isLoopbackUrl(publicHost)) {
      return `${publicHost}/api/v1/jsplugin/openlist/stream/${encodeURIComponent(encodeStreamToken(data))}`
    }

    // 2. 宿主地址非回环直接用;回环则取网卡 LAN 地址替换主机(保留端口)
    let base = ''
    let hostUrl = ''
    try {
      hostUrl = (await songloft.plugin.getHostUrl()) || ''
      if (hostUrl) {
        const u = new URL(hostUrl)
        base = `${u.protocol}//${u.host}`
      }
    } catch { /* ignore */ }

    if (!base || isLoopbackUrl(base)) {
      const addrs = await songloft.plugin.getNetworkAddresses()
      const lan = addrs && addrs[0]
      if (lan) {
        let port = ''
        try { port = new URL(hostUrl).port } catch { /* ignore */ }
        base = `http://${lan}${port ? ':' + port : ''}`
      }
    }

    if (!base || isLoopbackUrl(base)) {
      songloft.log.info('[OpenList] stream url: no reachable host (loopback only), fallback to import-only')
      return ''
    }
    return `${base.replace(/\/+$/, '')}/api/v1/jsplugin/openlist/stream/${encodeURIComponent(encodeStreamToken(data))}`
  } catch (e) {
    songloft.log.warn(`[OpenList] buildPublicStreamUrl failed: ${String((e as Error)?.message || e)}`)
    return ''
  }
}
