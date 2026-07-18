# AJI SUSHI 在线点餐系统 — 项目说明文档

**这份文档是干什么用的**：以后不管是开一个新的 Claude 对话、换一个开发者、还是你自己想回忆某个功能是怎么做的，把这份文档发给对方（或者贴给 Claude），就能很快搞清楚现在系统的完整状态，不用从头解释。

最后更新时间：2026年7月（如果你之后继续改动系统，记得让 Claude 顺手更新这份文档）。

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

网站的**代码**和网站的**数据**（订单、菜单、顾客信息等）是完全分开的两件事：

- **代码**：`server.js`、`*.html` 这些文件，存在 GitHub，每次你上传新文件就会更新。
- **数据**：存在下面两种方式**之一**（当前用的是第一种）：

### 当前用的：Render Persistent Disk（持久化磁盘）
- 磁盘挂载路径（Mount Path）：`/var/data`
- 对应的环境变量：`DATA_DIR=/var/data`
- 这两个值**必须完全一致**，改动任何一个之前一定要三思
- 费用：约 $0.25/月（1GB档位，实际用量远小于这个，不用担心超额）
- **已经实测验证过**：改数据 → 手动触发 Render 重新部署 → 数据还在，证明这套配置是好的

### 备选方案（当前没有用，仅供参考）：Upstash Redis
- 如果哪天想换成这个，需要设置 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 这两个环境变量
- **代码里的优先级是：只要检测到这两个变量存在，就会优先用 Upstash，完全忽略 Persistent Disk**——所以千万不要"顺手"把这两个变量也设置上，除非是真的打算切换存储方式，否则会导致"两套数据不同步"的混乱

### ⚠️ 绝对不能碰的东西
`server.js` 里有这几个内部常量/键名，**修改它们会导致系统突然"找不到"你现在存的所有真实数据**（不是丢失，是从系统的角度看好像换了个新数据库，一片空白）：
- Upstash 那套逻辑里用来标记数据的 key 名字（如果以后启用 Upstash）
- `SESSION_SECRET` 的默认值（如果之前一直没单独设置过环境变量）

**原则：这些内部标识符只加不改。**

---

## 三、部署 & 环境变量清单

### 必须设置的
| 变量名 | 作用 |
|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin.html 后台登录账号密码 |
| `DATA_DIR` | 设为 `/var/data`，对应 Persistent Disk 的挂载路径 |

厨房看板（restaurant-orders.html）的登录账号密码不是环境变量，是在 admin 后台的 "Credentials" 区块里单独设置的（`kitchenUser`/`kitchenPassword`），跟 admin 账号可以不一样。

### 可选功能对应的环境变量

| 功能 | 需要的环境变量 | 说明 |
|---|---|---|
| 新订单邮件提醒 | `EMAIL_USER`、`EMAIL_PASS` | Gmail 账号 + App Password（不是普通登录密码） |
| PrintNode 云打印（可能已弃用，见下方"打印"一节） | `PRINTNODE_API_KEY`、`PRINTNODE_PRINTER_ID` | 如果已经改用免费的 Epson 直连打印，这个可以考虑不要了，省 $9-10/月 |
| 免费打印桥（本地脚本轮询） | `PRINT_BRIDGE_SECRET` | 配合本地 `print-bridge.js` 脚本使用 |
| 在线支付（Stripe） | `STRIPE_SECRET_KEY` | 没设置的话，顾客只能选"到店付款"，没有在线支付选项，不影响其他功能 |
| 电话提醒（订单没确认自动打电话） | `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN`、`TWILIO_FROM_NUMBER` | 需要在 admin 后台 Site Info 里开启并填写要打给谁的号码 |
| 系统推送通知（新订单像手机消息一样弹出提醒） | `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`（可选） | 需要单独生成，见下方"推送通知"一节，密钥不能写进任何会上传的文件 |

---

## 四、各个页面的功能现状

### customer-order.html（顾客点餐页）
- 白底黑粉橙配色，菜品按分类展示，分类导航栏可横向滑动
- 菜品点击弹出详情弹窗：数量、备注、可选项（选项支持加价，见下方）
- 购物车是**居中弹窗样式**（不是铺满全屏的抽屉），每道菜价格/数量加减/删除在同一行显示，节省空间
- 手机号、邮箱**必填**才能下单
- 页脚有 "Powered by H.E Stanley" 字样
- 支持在线支付（Stripe，如果配置了的话）或到店付款

### restaurant-orders.html（接单看板）—— 这个页面改动最频繁，架构说明：
底部两个标签页切换：**Orders（订单）** / **Settings（设置）**

**Orders 主页**：
- 上半部分 "New Orders"（待确认），下半部分 "History"（已确认），都只显示顾客名字+金额
- 点名字打开详情页；只有从详情页点左上角"←"，或者**从屏幕左边缘往右滑**，才能返回主页
- 详情页现在是"去卡片化"的真满屏样式（无边框无圆角，贴边到底），字体和按钮都比一般网页大，方便厨房环境快速看清楚
- 待确认订单的确认方式：一个手动输入"几分钟后取餐"的数字框（不是选具体时间点，也不是系统的时间选择器），输入合法数字后 Accept 按钮立即变绿可点
- 菜品清单前后有红色分隔线标出"顾客点的菜从哪开始到哪结束"，颜色可以在 Settings → Appearance 里自定义
- 新订单响铃：**会一直响，响到你确认/拒绝这单为止**，不会自动停；用的是"背景持续循环播放，靠真正的播放/暂停开关控制"这套机制（因为 iOS 上没法用代码控制音量，之前踩过坑）

**Settings 设置页**：
- End of Day Report（今日订单数/营业额/已确认/待处理）
- Notifications（推送通知开关，见下方专门一节）
- Sound（Test Alarm / Sound On 按钮的显示开关，默认隐藏）
- Printing（自动打印开关 + Printer Stations 增删改，含默认打印机IP设置）
- Menu Items — Sold Out（可展开/收起的菜品售罄快捷开关列表）
- Language（占位，未实现功能）
- Appearance（详情页红色分隔线颜色自定义，存在本地 localStorage）

### admin.html（后台管理）
- 菜单管理改成了**侧边栏（左）+ 内容区（右）**的布局，不再是一长条竖着排的所有分类
- 支持批量勾选多道菜品，一次性拖到另一个分类
- 每道菜的选项组（optionGroups）现在支持给单个选项加价：在选项文本框里写 `选项名 +2.50` 即可，不写价格默认为 $0（详见下方"选项加价"一节）
- Site Info 里可以设置：营业时间、税率、打印机IP、电话提醒开关和号码、打印开关等

---

## 五、几个专门功能的实现细节

### 0. 核心数据结构参考（新对话最容易漏看的部分）

**订单对象（order）**大概长这样：
```
{
  id, num,                          // num是显示给顾客/员工看的订单号
  items: [{ dishId, name, price, qty, note, options: {选项组标题: 选中的值或数组}, printRouting }],
  subtotal, tax, total,
  name, phone, email, location, deliveryAddress,
  status: 'pending' | 'confirmed',  // 只有这两种状态
  pickupTime, pickupTimestamp,      // 确认时才会填
  createdAt, paid, paymentMethod,
  isNewCustomer,                    // 首次下单标记
  lastCallAt, callCount             // 电话提醒功能用
}
```

**菜品对象（dish，在 `data.config.menu[分类].items` 里）**：
```
{
  id, name, desc, price, soldOut, hot,
  optionGroups: [{ id, label, type: 'single'|'multi', count, choices: [...] }],
  printRouting: [{ station, label }]
}
```
`choices` 数组里每一项可以是**纯字符串**（老格式，无加价）或者 **`{name, price}` 对象**（新格式，price是选中后要加的钱）。读取的时候两种格式都要兼容处理（三个文件里都有 `choiceName()`/`choicePrice()` 这两个兼容函数）。

**订单超过48小时会被自动清理**（`data.orders` 里有清理逻辑），`data.knownCustomers`（用来判断新老顾客）不受这个清理影响，会一直保留。

### 1. 打印
两套并行的打印方案：
- **直连打印（推荐，免费）**：厨房平板通过局域网直接把小票发给 Epson 打印机，用的是 Epson ePOS-Print 协议。IP 在 admin 后台或接单页 Settings 里设置。
- **PrintNode（付费）**：如果还在用，是走云端转发，每月固定费用。如果已经全面切换到直连打印，建议去 PrintNode 官网取消订阅省钱。

### 2. 选项组加价
菜单里的"选项组"（比如"Choose 2 Rolls"这种）现在选项可以带价格：
- 数据格式：`choices` 数组里每一项可以是纯字符串（老格式，价格默认0，向下兼容）或者 `{name, price}` 对象（新格式）
- admin 后台编辑时用文本框，格式是"选项名 +价格"，比如：
  ```
  Miso Soup
  Salad
  Beef +2.50
  ```
- 顾客点餐页选中带价格的选项后，价格会实时体现在弹窗和购物车里
- **注意**：服务器不会重新校验价格是否正确（一直是这样，不是这次新加的问题），完全信任顾客浏览器提交的金额。真出问题的话（比如有人改数据包），这是个已知的、贯穿整个系统的潜在风险，如果以后想收紧安全性，这是要单独处理的一块。

### 3. 电话提醒（Twilio）
订单超过设定时间（默认5分钟）没确认，自动打电话到指定号码提醒，每5分钟重打一次直到确认。需要 Twilio 账号（付费，但很便宜）。

### 4. 系统推送通知（Web Push / PWA）
新订单可以像手机短信/App消息一样直接弹通知，不需要网页开着。

**密钥不写在这份文档里**——密钥这类东西不应该出现在任何会被上传到 GitHub 的文件里（之前犯过这个错误，导致 GitHub 密钥扫描报警，已经作废重新生成）。密钥只应该：
1. 直接在 Render 后台的 Environment Variables 页面里填写
2. 或者存在你自己电脑上一个**不会上传**的本地文件里（比如加进 `.gitignore` 排除的 `.env`）

如果需要重新生成一组新密钥，让 Claude 用 Node.js 的内置 `crypto` 模块生成 EC P-256 密钥对再转换成 VAPID 需要的格式即可，不需要联网也能生成。

**新增的3个静态文件**（必须和其他文件一起在同一目录）：`kitchen-manifest.json`、`kitchen-sw.js`、`kitchen-icon.png`

**员工怎么开启**：
1. iPhone 用 **Safari**（不是Chrome）打开接单网址 → 分享 → 添加到主屏幕
2. 从桌面新图标打开（不是从浏览器标签页）
3. 接单页 Settings → Notifications → 点 "Enable"，同意系统通知权限

安卓不强制要求添加到主屏幕，直接在浏览器里开启即可。

**注意**：这个功能背后的推送发送逻辑，因为开发环境没法联网做端到端测试，理论上应该没问题，但**没有做过完整的真机验证**，如果发现推送没收到，需要进一步排查（比如检查 Render 日志里 `web-push` 有没有报错）。

### 5. 打印机 vs POS 系统（MenuSifu）
目前这套点餐系统跟你店里用的 MenuSifu POS 是**完全独立、没有打通**的——MenuSifu 没有对外公开的开发者接口，无法自己写代码对接。如果以后想打通，现实的路径是：
- 联系 MenuSifu 官方问有没有定制对接方案
- 或者花钱订阅 Deliverect / ItsaCheckmate 这类中间商平台（前提是它们真的支持接入自定义网站，需要先问清楚）
- 或者干脆自己从零做一套完整 POS（工程量巨大，需要额外考虑刷卡支付合规问题，建议走 Stripe Terminal 这类官方认证的收款终端方案，不要自己处理银行卡数据）

---

## 六、当前费用情况（截至最近一次核对）

| 服务 | 大概费用 | 状态 |
|---|---|---|
| Render 网站托管 | 约 $7/月起 | 在用，具体以 Render 账单为准 |
| Render Persistent Disk | 约 $0.25/月 | 在用，已验证数据持久化正常 |
| 域名 ajibrewster.com | 约$10-15/**年** | 在用 |
| PrintNode | 约 $9-10/月 | **待确认是否还需要**，已有免费直连打印替代方案 |
| Twilio（电话提醒） | 号码租金约$1.15/月 + 通话按分钟 | 只有开启电话提醒功能才会产生费用 |
| Upstash / Stripe / Gmail / Web Push | 免费或按实际使用量 | — |

---

## 七、如果要开一个新的对话继续开发

把这份 README 贴给 Claude，再补充一句你现在具体想改什么。如果涉及到看现有代码的具体实现，把对应的文件也一起上传（`server.js`、三个 `.html` 文件），因为 Claude 不会自动记得之前对话里的代码细节。

**几个容易踩的坑，新对话也要提醒 Claude 注意：**
1. 不要随便改 `DATA_DIR`、Persistent Disk 挂载路径，或者贸然加上 Upstash 的环境变量（除非明确要切换存储方式）
2. iOS Safari/Chrome 上无法用 JS 控制 `<audio>` 的音量（`.volume` 不生效），控制声音只能用真正的播放/暂停
3. 部署后如果发现"改动没生效"，先怀疑是不是 Render 没有真正重新部署 / 浏览器缓存问题，而不是代码错了
4. 菜单选项组的 `choices` 字段现在支持字符串或 `{name, price}` 对象两种格式，改动相关代码时两种都要兼容
5. **任何密钥/密码类的真实数值，绝对不能写进任何会上传到 GitHub 的文件里**（包括这份 README 本身）——之前就因为把 VAPID 私钥直接写进 README 导致 GitHub 密钥扫描报警、密钥作废重生成。密钥只应该：直接填在 Render 的 Environment Variables 里，或者让 Claude 每次要用的时候临时生成/展示在聊天对话中（不写入文件）
