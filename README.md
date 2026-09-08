# AJI SUSHI 在线点餐系统 — 项目交接文档

**这份文档是干什么用的**：给接手这个项目的新对话窗口（或者新的开发者）快速了解现在系统的完整状态。开新对话的时候，把这份文档 + 相关代码文件一起发过去，就能快速接上进度，不用从头解释。

最后更新时间：2026年8月。

---

## ⚠️ 零、当前正在处理、还没解决的问题（新窗口请先看这里）

### 菜品图片上传功能，目前还在报错，没修好

**背景**：最近加了"给每道菜上传照片"的功能（后台admin.html上传，顾客点餐页面显示缩略图+点击放大）。上传的图片存成独立文件放在持久化磁盘上（不是塞进data.json数据库里）。

**出问题的过程**：
1. 一开始做了个"自动压缩图片"的功能（用 `sharp` 这个工具包），上传后**全部失败**（9张全挂）
2. 怀疑是 `sharp` 这个包在 Render 上装/跑的时候有问题，于是**回滚**，把压缩功能整个撤掉，恢复成"直接存原图，不压缩"的简单版本
3. **回滚之后，上传还是失败**（这次只测了1张，也失败了）——说明问题**不是** `sharp` 造成的，是别的原因，具体是什么还不确定
4. 最后一步：给上传接口加了详细的报错信息回显（之前只显示"失败"，现在会显示具体是哪一步、什么错误），但**还没有拿到用户实际测试后的报错内容**，所以还不知道根本原因是什么

**下一步该做什么**：
1. 先让用户在最新版本上重新测试一次上传（单张或批量都行）
2. 这次应该会显示具体的错误信息（类似"Server could not save the photo: xxx"这种），把这段话拿到手
3. 根据具体报错内容判断问题所在，可能的方向：
   - 持久化磁盘的 `images` 子文件夹创建/写入权限有问题
   - `IMAGES_DIR` 路径计算得不对
   - `requireAdminAuth` 中间件在某些请求下的行为异常
   - 请求体大小限制（虽然已经设了15mb，但要确认没有被别的中间件覆盖）
   - 也有可能是完全想不到的别的原因，需要看到真实报错才能判断

**这个功能涉及的代码位置**：
- `server.js`：`app.post('/api/upload-dish-image', ...)`、`app.post('/api/remove-dish-image', ...)`、`IMAGES_DIR` 相关设置（在 `DATA_FILE` 定义附近）
- `admin.html`：菜品行的照片缩略图/上传按钮、批量上传按钮（`batchUploadPhotosBtn`）
- `customer-order.html`：菜品卡片里的缩略图显示、点击放大的 lightbox 弹窗

---

## 一、这是什么系统

一套给 **AJI SUSHI** 餐厅用的自建在线点餐系统，包含三个页面 + 一个后端服务：

| 文件 | 是什么 | 谁在用 |
|---|---|---|
| `customer-order.html` | 顾客点餐页面 | 公开网址，任何顾客都能访问下单 |
| `restaurant-orders.html` | 接单看板（"厨房屏"） | 店内员工用来接单、确认取餐时间、管理设置，需要账号密码登录 |
| `admin.html` | 后台管理 | 老板/管理员用来改菜单、店铺信息、打印设置等，需要账号密码登录 |
| `server.js` | 后端服务器（Node.js/Express） | 处理所有页面背后的逻辑和数据存储 |

**部署方式**：GitHub 仓库（`hestanleyllc/aji-sushi-ordering123123`）+ Render 托管（`ajibrewster.com` 域名）。改代码 → 上传到 GitHub → Render 自动/手动重新部署。

---

## 二、数据存储 —— ⚠️ 最重要的一节，改动前必读

网站的**代码**和网站的**数据**（订单、菜单、顾客信息、菜品图片等）是完全分开的两件事：

- **代码**：`server.js`、`*.html` 这些文件，存在 GitHub，每次上传新文件就会更新。
- **数据**：存在 Render 的 **Persistent Disk（持久化磁盘）** 上
  - 磁盘挂载路径（Mount Path）：`/var/data`
  - 对应的环境变量：`DATA_DIR=/var/data`
  - 这两个值**必须完全一致**，改动任何一个之前一定要三思
  - 费用：约 $0.25/月（1GB档位）
  - **已经实测验证过**：改数据 → 手动触发 Render 重新部署 → 数据还在，证明这套配置是好的
- **菜品图片**：存在同一块磁盘的 `/var/data/images/` 子文件夹里，数据库（data.json）里只记图片的URL路径，不存图片本身

### ⚠️ 绝对不能碰的东西
- 不要随便加 `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` 这两个环境变量——只要检测到这两个存在，系统会**优先用 Upstash**、完全忽略 Persistent Disk，会导致"两套数据不同步"的混乱
- `SESSION_SECRET` 的默认值不要改（如果之前一直没单独设置过环境变量的话）
- **任何密钥/密码类的真实数值，绝对不能写进任何会上传到 GitHub 的文件里**（包括这份 README 本身）——之前就因为把 VAPID 私钥直接写进 README 导致 GitHub 密钥扫描报警、密钥作废重新生成。密钥只应该：直接填在 Render 的 Environment Variables 里，或者让 Claude 每次要用的时候临时生成/展示在聊天对话中（不写入文件）

---

## 三、部署 & 环境变量清单

### 必须设置的
| 变量名 | 作用 |
|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin.html 后台登录账号密码 |
| `DATA_DIR` | 设为 `/var/data`，对应 Persistent Disk 的挂载路径 |

厨房看板（restaurant-orders.html）的登录账号密码不是环境变量，是在 admin 后台的 "Login Credentials" 区块里单独设置的（`kitchenUser`/`kitchenPassword`），跟 admin 账号可以不一样。

### 可选功能对应的环境变量

| 功能 | 需要的环境变量 | 说明 |
|---|---|---|
| 新订单邮件提醒 / 每月数据备份邮件 | `EMAIL_USER`、`EMAIL_PASS` | Gmail 账号 + App Password（不是普通登录密码） |
| PrintNode 云打印（可能已弃用） | `PRINTNODE_API_KEY`、`PRINTNODE_PRINTER_ID` | 已有免费的 Epson 直连打印方案，建议确认是否还需要这个，不需要可以取消订阅省钱 |
| 免费打印桥（本地脚本轮询） | `PRINT_BRIDGE_SECRET` | 配合本地 `print-bridge.js` 脚本使用 |
| 在线支付（Stripe） | `STRIPE_SECRET_KEY` | 没设置的话，顾客只能选"到店付款" |
| 电话提醒 + 短信通知（Twilio） | `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN`、`TWILIO_FROM_NUMBER` | 电话提醒是打给餐厅的（订单没确认自动打电话）；短信通知是发给顾客的（订单确认后自动发短信），两个功能共用这一组账号 |
| 系统推送通知（新订单像手机消息一样弹出提醒） | `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`（可选） | 需要单独生成，密钥不能填进任何文件里 |
| POS 系统同步 | `POS_SYNC_SECRET` | 自己定一串密钥（20位左右字母数字混合），两边（Render环境变量 + POS后台设置）必须填一模一样的值 |

---

## 四、各个页面的功能现状

### customer-order.html（顾客点餐页）
- 白底黑粉橙配色，菜品按分类展示，分类导航栏可横向滑动（带滚动条）
- 菜品卡片：如果上传了照片，菜名旁边显示小缩略图（懒加载），**点击缩略图弹出居中大图**
- 菜品点击弹出详情弹窗：数量、备注、可选项（选项支持加价，多选类型的选项支持重复选同一个）
- 顶部有"预计取餐时间 15-20分钟"的提示条，店铺关门时自动隐藏
- 购物车是居中弹窗样式，每道菜价格/数量加减/删除在同一行显示
- 手机号、邮箱**必填**才能下单
- **老顾客一键再来一单**：下单成功后记在这台设备的浏览器里，下次访问会有"欢迎回来，要不要再来一单"的提示
- **下单后的确认弹窗，在餐厅确认取餐时间之前无法关闭**（背景点击、logo点击都被拦下来了）；**超过3分钟还没确认，会提示"餐厅繁忙，请拨打电话XXX"**；如果订单被员工拒绝，会立刻显示"抱歉无法接单，请致电"
- 订单确认后，确认弹窗底部会出现"给我们留个Google评价"的链接（需要在后台设置 Google Review Link）
- **顾客端中英文切换**：点导航菜单里的"🌐 中文/English"，翻译的是网站界面文字（按钮、标签），**不包括菜品名称和描述**（那些还是后台录入时的语言）
- 页脚有 "Powered by H.E Stanley" 字样

### restaurant-orders.html（接单看板）
底部两个标签页切换：**Orders（订单）** / **Settings（设置）**

**Orders 主页**：
- 上半部分 "New Orders"（待确认），下半部分 "History"（已确认），都只显示顾客名字+金额
- 电话号码统一格式化显示成 `646-397-9159` 这种带横杠的样式
- 点名字打开详情页；只有点左上角"←"或者从屏幕左边缘往右滑，才能返回主页
- **待确认订单是两步流程**：先只显示"✕拒绝"和"Accept接受"两个按钮；点了"Accept"才会弹出取餐时间的数字输入框（填"几分钟后"）和真正的ACCEPT确认按钮；输入的时候会自动把确认按钮滚动到键盘上方，不会被遮住
- 超过5分钟没确认的订单，自动标红显示"MISSED ORDER"，并且不再持续触发响铃（不管是正常等待中变成超时，还是断网重连后突然发现的旧订单，都按订单的真实下单时间判断，不会有遗漏或者误判）
- 已确认的订单，如果开启了POS同步，会显示"📤 Sync to POS"按钮
- 新订单响铃：会一直响到确认/拒绝为止，用的是系统循环播放+真正播放/暂停开关（不是调节音量，因为iOS不支持代码控制音量）

**Settings 设置页**：
- End of Day Report（今日订单数/营业额/已确认/待处理）
- App Install（跨浏览器通用的"添加到主屏幕"引导，会根据浏览器类型给出对应的操作说明）
- Notifications（推送通知开关）
- Sound（Test Alarm / Sound On 按钮的显示开关，默认隐藏）
- Printing（自动打印开关 + Printer Stations 增删改）
- Menu Items — Sold Out（可展开/收起的菜品售罄快捷开关列表）
- Language（占位，未实现功能）
- Appearance（详情页红色分隔线颜色自定义）
- Data Backup 相关内容在 admin.html 里，不在这个页面

### admin.html（后台管理）
- 菜单管理是侧边栏（左）+ 内容区（右）的布局
- 支持批量勾选多道菜品，一次性拖到另一个分类
- 每道菜的选项组支持给单个选项加价（文本框里写"选项名 +2.50"）
- **每道菜可以上传照片**（目前有bug，见文档最上面第零节）；也支持**批量上传**，靠"文件名跟菜名完全一致"来自动配对（比如照片叫 `Alaska Roll.jpg`，会自动配到菜单里叫"Alaska Roll"的那道菜）
- Site Info 里可以设置：营业时间（含"特殊日期例外"，比如某天临时关门/调整营业时间，优先级高于每周固定时间表）、税率、打印机IP、电话提醒开关和号码、打印开关、Google评论链接
- Data Backup 区块：能立即下载一份当前完整数据的JSON备份；另外系统每个月会自动发一封备份邮件到通知邮箱

---

## 五、几个专门功能的实现细节

### 0. 核心数据结构参考

**订单对象（order）**：
```
{
  id, num,
  items: [{ dishId, name, price, qty, note, options: {选项组标题: 选中的值或数组}, category, printRouting }],
  subtotal, tax, total,
  name, phone, email, location, deliveryAddress,
  status: 'pending' | 'confirmed',
  pickupTime, pickupTimestamp,
  createdAt, paid, paymentMethod,
  isNewCustomer,
  lastCallAt, callCount,           // 电话提醒功能用
  posSynced, posSyncRequested      // POS同步功能用
}
```

**菜品对象（dish，在 `data.config.menu[分类].items` 里）**：
```
{
  id, name, desc, price, soldOut, hot,
  image,                           // 图片URL路径，比如 /images/dishId.jpg?v=时间戳
  optionGroups: [{ id, label, type: 'single'|'multi', count, choices: [...] }],
  printRouting: [{ station, label }]
}
```
`choices` 数组里每一项可以是纯字符串（老格式，无加价）或者 `{name, price}` 对象（新格式）。

**订单超过48小时会被自动清理**，`data.knownCustomers`（判断新老顾客用）不受清理影响。

### 0.5 API 接口完整清单

**顾客点餐相关：**
| 方法 | 地址 | 作用 |
|---|---|---|
| GET | `/api/config` | 获取菜单、店铺信息等公开配置 |
| GET | `/api/store-status` | 查询店铺现在是否营业中 |
| POST | `/api/orders` | 顾客提交新订单（服务器会重新校验价格，不信任浏览器提交的数字） |
| POST | `/api/checkout` | 发起 Stripe 在线支付（同样会重新校验价格） |
| GET | `/api/checkout/verify` | 验证支付是否成功 |

**接单/厨房相关：** 🔒需要厨房账号
| 方法 | 地址 | 作用 |
|---|---|---|
| GET | `/api/orders` | 获取所有订单列表 |
| GET | `/api/orders/:id` | 获取单个订单详情（公开，顾客确认页也用这个） |
| PATCH | `/api/orders/:id` | 更新订单状态（确认取餐时间、标记POS同步请求等） |
| DELETE | `/api/orders/:id` | 删除/拒绝订单 |
| GET | `/api/events` | SSE 实时推送 |

**管理后台相关：** 🔒需要管理员账号
| 方法 | 地址 | 作用 |
|---|---|---|
| POST | `/api/config` | 保存菜单、店铺设置等 |
| POST | `/api/credentials` | 修改后台/厨房登录账号密码 |
| POST | `/api/upload-dish-image` | 上传菜品照片（**目前有bug**） |
| POST | `/api/remove-dish-image` | 删除菜品照片 |
| GET | `/api/backup` | 立即下载完整数据备份 |

**POS同步相关：** 🔒需要 `POS_SYNC_SECRET` 密钥（不是员工登录）
| 方法 | 地址 | 作用 |
|---|---|---|
| GET | `/api/pos-sync/orders?secret=xxx` | POS拉取已确认、还没同步过的订单 |
| POST | `/api/pos-sync/orders/:id/ack?secret=xxx` | POS确认已处理完这笔订单 |

**其他辅助功能：**
| 方法 | 地址 | 作用 |
|---|---|---|
| POST | `/api/kitchen-settings` 🔒厨房 | 打印开关、默认打印机IP |
| POST | `/api/kitchen-print-stations` 🔒厨房 | 增删打印站点 |
| POST | `/api/menu-soldout` 🔒厨房 | 快捷标记菜品售罄 |
| GET/POST | `/api/push-*` 🔒厨房 | 推送通知订阅相关 |
| GET/POST | `/api/print-queue*` | 免费打印桥轮询用 |

### 1. 价格安全校验（重要）
`server.js` 里有个 `computeAuthoritativePricing()` 函数，**所有订单的价格都会用后台真实菜单数据重新计算**，不信任顾客浏览器提交的数字。这个函数：
- 优先按 `dishId` 精确匹配菜品（顾客下单时浏览器会带上这个字段）
- 如果ID对不上，会按**菜名**兜底查找（优先在提交时标注的分类里找，减少重名菜品匹配错误的概率）
- Stripe在线支付和到店付款**两条路径都会走这个校验**，确保顾客实际付的钱和后台记录的订单金额一致

**这块历史上出过好几次bug**（税率读取失败变成0、菜品ID没有实际传给服务器导致校验形同虚设、Stripe路径最初没有走校验），都已经修复，但如果以后改动这块代码，务必谨慎测试。

### 2. 打印
两套并行方案：直连打印（Epson ePOS-Print协议，免费）和 PrintNode（付费，可能已不需要）。

### 3. 选项组加价 + 可重复选择
后台文本框格式："选项名 +价格"。多选类型（"Any 2/3 Rolls"这种）支持**重复选同一个选项**，界面是每个选项旁边独立的加减号，不是打勾checkbox。

### 4. 电话提醒（Twilio，打给餐厅） + 短信通知（Twilio，发给顾客）
共用同一组 Twilio 账号。短信发送前会把顾客手打的各种电话号码格式，自动转换成 Twilio 要求的标准格式（`+1XXXXXXXXXX`），格式实在无法识别的会跳过发送而不是报错。

### 5. 系统推送通知（Web Push / PWA）
新订单可以像系统消息一样直接弹通知。密钥生成方式见上面"绝对不能碰的东西"一节。3个静态文件（`kitchen-manifest.json`、`kitchen-sw.js`、`kitchen-icon.png`）必须跟其他文件放在同一目录。iPhone必须用Safari"添加到主屏幕"后才能开启通知；接单页 Settings 里的"App Install"按钮能自动判断当前浏览器、给出对应操作指引。

### 6. POS 系统同步
跟餐厅现在用的 MenuSifu POS 没有官方API对接（MenuSifu不对外开放开发者接口）。目前用的方案是：POS 每隔一段时间主动来问网站"有没有新确认的订单"（走 `/api/pos-sync/orders`），拿到后自动导入。员工在接单页确认订单后，需要（或者POS设置成自动模式的话不需要）额外点一下"📤 Sync to POS"按钮，才会把订单标记为"可以给POS拿"。

**另外还有一个完全独立的项目**：用户在**另一个 Claude Code 项目**（存在他电脑上 `pos-windows` 文件夹里）用 OpenClaw 做桌面自动化，把网站订单模拟人工操作的方式录入 MenuSifu 桌面客户端。这个跟上面的POS同步API是两套不同的方案，都在推进，不要搞混。

### 7. 菜品图片（**当前有bug，见文档最上面**）
存储方式：真实文件存在持久化磁盘的 `/var/data/images/` 文件夹，数据库里只存URL。支持单张上传和**批量上传**（按文件名自动匹配菜名，配不上的会列出来提示手动处理）。之前尝试加"服务器自动压缩"功能（用`sharp`库）导致上传全部失败，已回滚。回滚后上传仍然失败，原因未知，正在诊断中。

### 8. 数据备份
每月自动发一封邮件（附件是完整数据JSON）到后台设置的通知邮箱；另外 admin 后台有"Download Backup Now"按钮可以随时手动下载。

---

## 六、当前费用情况

| 项目 | 大概费用 |
|---|---|
| Render 网站托管 | 约 $7/月起 |
| Render Persistent Disk | 约 $0.25/月 |
| 域名 ajibrewster.com | 约$10-15/年 |
| PrintNode（待确认是否还需要） | 约 $9-10/月 |
| Twilio（电话提醒+短信通知） | 号码租金约$1.15/月 + 通话/短信按量 |
| Upstash / Stripe / Gmail / Web Push | 免费或按实际使用量，Upstash目前没有启用 |

---

## 七、给新对话/新开发者接手的重要提醒

1. 不要随便改 `DATA_DIR`、Persistent Disk 挂载路径，或者贸然加上 Upstash 的环境变量
2. iOS Safari/Chrome 上无法用 JS 控制 `<audio>` 的音量，控制声音只能用真正的播放/暂停
3. 部署后如果发现"改动没生效"，先怀疑是不是 Render 没有真正重新部署 / 浏览器缓存问题，而不是代码错了
4. 菜单选项组的 `choices` 字段支持字符串或 `{name, price}` 对象两种格式，改动相关代码时两种都要兼容
5. **任何密钥/密码类的真实数值，绝对不能写进任何会上传到 GitHub 的文件里**（包括这份 README 本身）
6. 每次改完关键功能（尤其是价格计算、支付相关代码），**务必要求实际测试后再确认完成**，这个项目历史上有过好几次"看起来改好了、实际上线后才发现新bug"的情况（比如价格校验、税率计算、图片上传都出过这种问题），改完不能想当然，要看真实的测试结果或者报错信息
7. 目前进行中、还没解决的问题见文档最上面"零、当前正在处理的问题"这一节


### Kitchen live-update bandwidth optimization
The kitchen board uses SSE as the primary real-time channel. While SSE is connected there is no periodic order polling. If SSE disconnects, a 3-second fallback poll starts automatically and stops immediately when SSE reconnects.
