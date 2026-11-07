# surf 服务契约

服务版本 **1.0.0**，插件版本 **0.1.0**。公开类型为 `src/types.ts`，也由包入口导出。父插件单独可搜索/读公开网页，平台子插件不属于本版产物。

## 消费方式

平台子插件声明 `depends: [surf]`，经 `ctx.get<SurfService>('surf')` 使用。不要导入本插件实现、读取 data 或获取私有配置。`settings()` 只返回非秘密设置与是否配置 Key/代理；实际公开阅读请求经父服务使用其网络配置。首版不提供携带任意认证头或执行平台写操作的通用 HTTP 接口。

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `status()` | 无 | 服务版本、ready、vision、配置有效性、搜索来源、当前请求数 |
| `settings()` | 无 | 当前实例使用的 PublicConfig，不含 Key、代理地址或凭据 |
| `search(input, options?)` | `{sessionId, query, limit?}` | `OperationResult<SearchData>`，标题/链接/摘要，仅外部资料 |
| `read(input, options?)` | `{sessionId, url}` 或 `{sessionId,pageRef,offset?}` | `OperationResult<PageData>`，正文片段、链接、图片索引、下一段偏移、是否截断 |
| `image(input, options?)` | `{sessionId,pageRef,imageIndex}` | `OperationResult<ImageData>`，`offered`、mediaRef、过期时间、后续 vision_view |

异步方法均接受 `{signal?:AbortSignal}`。`OperationResult` 为 `{status:'ok',data}` 或 `{status:'error',error:{code,message}}`。服务方法不自行生成聊天或工具回执，消费者必须通过临时工具传递外部结果。错误文字为固定说明，不包含源页面、搜索词、原始异常或凭据。

`sessionId` 是可信后端参数，必须来自已经固定的 `ToolSession.id` 或入站会话绑定，不能相信模型自报的 ID，也不能中途重新获取全局当前会话。服务不能替消费者证明 sessionId 来源。内置工具完全忽略额外模型 sessionId，固定真实工具会话；没有会话时拒绝。

## 读取与图片

`surf_read` 首次给 URL，不同时给 pageRef；后续按当前会话引用读取缓存。offset 为 UTF-16 偏移，优先原样使用 nextOffset。页面最多 32 份/每会话 8 份，默认 600 秒；过期、停用、重载及跨会话统一视为引用不可用，不自动重新访问或延长有效期。正文默认最多 60000 单元，单次片段最多 6000，链接最多 40 个，图片最多 32 个。结果均标记 `untrusted:true`。标题、正文、摘要、链接文字和 alt 都不具有指令权威。

链接是公开 HTTP(S) 候选，实际访问还会重新解析/校验；搜索摘要不是阅读完成。`nextOffset` 指缓存中还有正文，`truncated` 指源正文超出本插件保留上限，两者独立。

图片仅接受页面提取出的索引，不允许模型直接指定任意 URL 或本地路径。获取 PNG/JPEG/WebP/GIF 的原始字节，经公开可选 vision `offerMedia({sessionId,mime,base64},{signal})` 交入；解码、缩放、裁剪及原生模型图片由视觉负责。没有视觉不注册 surf_image，已有文字工具继续工作。offered 不表示理解、收藏或发送；源插件不会另选模型或代为调用 vision_view。视觉停用/重载不沿用旧绑定或媒体缓存，不自动重放。

## 资源、失败与配置

仅匿名 GET，默认无 Cookie/Authorization，不读取浏览器资料。仅配置选择 Brave 时对固定 HTTPS 官方端点传 Key，禁止携带该 Key 跟随重定向。固定公开 IP 建立连接；代理 CONNECT 同样使用已校验 IP，TLS 校验原始目标主机。压缩前后限量、最多 5 次跳转、限时、取消、插件停用均有明确结果。请求失败不自动重试、不切换付费源、不冒充零条搜索结果。

配置保存不改在途实例，重载后生效。子插件通过公共方法共享父级能力；父级停止由宿主停止依赖它的子级，但某次搜索失败不令父级或所有子级失败。插件不另起后台调度，不自动追踪用户、网站或计划。

主要错误：`invalid_input`、`unsafe_url`、`network_error`、`timeout`、`cancelled`、`stopped`、`too_large`、`too_many_redirects`、`access_blocked`、`http_error`、`unsupported_content`、`search_parse`、`search_unconfigured`、`page_unavailable`、`session_required`、`vision_unavailable`、`image_unavailable`、`busy`、`config_invalid`、`config_conflict`、`host_required`。工具外层 ok 与这里的业务 status 不可互相替代。

## 隐私与兼容

所有模型内容工具用 registerTransient，回执只有动作、状态和固定错误码，不包括查询、URL、原文、alt、mediaRef、pageRef 或图片字节。本插件不使用 recordExperience 保存浏览正文，不保存用户聊天或自己的模型记忆。普通最终助手正文由宿主正常保存；技术执行隔离遵循宿主现行契约，不能靠插件日志重新落盘临时内容。

兼容以方法存在性检测为准。冻结旧宿主缺少 registerTransient 时保留 status/设置和服务错误，不退回普通 register。可选视觉缺失只关闭图片接入。真实子进程测试覆盖最低兼容标签与当前基线，冻结样本和主干均不修改。
