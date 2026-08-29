// 服务器配置持久化 — 基于 songloft.storage,key = openlist_configs

import type { OpenListConfig } from './types'

const CONFIG_KEY = 'openlist_configs'
const PUBLIC_HOST_KEY = 'openlist_public_host'

export async function getConfigs(): Promise<OpenListConfig[]> {
  try {
    const val = await songloft.storage.get(CONFIG_KEY)
    if (val) {
      const parsed = typeof val === 'string' ? JSON.parse(val) : val
      if (Array.isArray(parsed)) return parsed as OpenListConfig[]
    }
  } catch (err) {
    songloft.log.error(`[OpenList] Failed to load configs: ${String(err)}`)
  }
  return []
}

export async function saveConfigs(configs: OpenListConfig[]): Promise<void> {
  await songloft.storage.set(CONFIG_KEY, JSON.stringify(configs))
}

export async function getConfig(name: string): Promise<OpenListConfig | undefined> {
  const configs = await getConfigs()
  return configs.find(c => c.name === name)
}

// ===== 对外地址(音箱可达的 Songloft 宿主地址) =====
// Docker 部署时宿主自动推导拿不到局域网地址(容器网卡 172.x 被宿主过滤),
// 需要在这里手动指定,如 http://192.168.1.190:58091

export async function getPublicHost(): Promise<string> {
  try {
    const val = await songloft.storage.get(PUBLIC_HOST_KEY)
    if (val) return String(val).trim().replace(/\/+$/, '')
  } catch (err) {
    songloft.log.error(`[OpenList] Failed to load public host: ${String(err)}`)
  }
  return ''
}

export async function savePublicHost(host: string): Promise<void> {
  let normalized = host.trim().replace(/\/+$/, '')
  if (normalized && !/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`
  await songloft.storage.set(PUBLIC_HOST_KEY, normalized)
}
