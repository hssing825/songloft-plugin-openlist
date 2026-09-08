/// <reference types="@songloft/plugin-sdk" />
// 插件入口 — 只挂生命周期钩子与请求分发,业务逻辑见 router.ts 与 routes/

import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk'
import router from './router'

// 向 miot 注册为「外部搜索源候选」（可选增强）。
// 延迟 + 重试调用，避免与 miot 同时启动时对方尚未就绪的竞态；
// miot 未安装 / host 不支持 comm 时静默跳过，绝不阻塞自身功能。
function registerSearchProviderToMiot(): void {
  let attempts = 0
  const tryRegister = async () => {
    attempts++
    try {
      if (!songloft.comm || typeof songloft.comm.call !== 'function') return // 旧 host 无 comm
      await songloft.comm.call('miot', 'register-search-provider', {
        name: 'OpenList',
        searchPath: '/api/search/topone',
      }, 5000)
      songloft.log.info('[OpenList] 已向 miot 注册搜索源候选')
    } catch (e) {
      if (attempts < 5) {
        setTimeout(tryRegister, 3000)
      } else {
        songloft.log.info('[OpenList] miot 未安装/未就绪，放弃注册: ' + String(e))
      }
    }
  }
  setTimeout(tryRegister, 2000)
}

async function onInit(): Promise<void> {
  songloft.log.info('[OpenList Plugin] Mounted')
  registerSearchProviderToMiot()
}

async function onDeinit(): Promise<void> {
  // 这里**不**向 miot 注销「外部搜索源候选」：
  // 宿主空闲驱逐（约 10 分钟无活动）也会触发 onDeinit，注销会删掉 miot 注册表里的条目，
  // 表现为设置页候选消失、必须点一次插件重新 onInit 才回来。
  // 禁用/卸载场景由 miot 侧的 installed/active 过滤兜底，无需插件自删。
  songloft.log.info('[OpenList Plugin] Unmounted')
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req)
}

// QuickJS 需要显式挂到全局
globalThis.onInit = onInit
globalThis.onDeinit = onDeinit
globalThis.onHTTPRequest = onHTTPRequest
