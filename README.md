# Maple & Main — 部署说明(v2:不需要 public 子文件夹)

这一版所有文件都在**同一层**,不用再管文件夹结构对不对：

- `server.js` — 后端服务
- `package.json` — 项目配置
- `customer-order.html` — 顾客点餐页（公开链接）
- `restaurant-orders.html` — 餐馆接单看板（内部使用，不要公开分享）
- `admin.html` — 菜单/网站信息管理后台（**已加密码保护**）

## 上传到 GitHub（重新覆盖之前的仓库）

1. 打开你现有的 GitHub 仓库页面
2. 把仓库里现在所有文件全部删掉（可以逐个点开文件 → 右上角垃圾桶图标删除，或者直接删除整个仓库重建一个新的）
3. 点击 `Add file` → `Upload files`
4. 把这次压缩包解压后的 **5 个文件**（server.js、package.json、customer-order.html、restaurant-orders.html、admin.html）**一次性全部拖进浏览器窗口**——注意这次不需要任何子文件夹，5个文件全部平铺上传即可
5. 下面提交说明写一句，比如 `fix: flat file structure`，点 `Commit changes`
6. 上传完成后，仓库首页应该只列出这 5 个文件（外加 GitHub 可能自动生成的说明），**不应该有 `public` 文件夹**

## Render 重新部署

1. 回到你的 Render 项目页面
2. 右上角 `Manual Deploy` → `Deploy latest commit`
3. 等 2-3 分钟，看到 `Your service is live` 就成功了

## 验证

部署完成后，直接访问这三个网址应该都能正常打开（不再是 "Cannot GET"）：

- `https://你的项目名.onrender.com/customer-order.html`
- `https://你的项目名.onrender.com/restaurant-orders.html`
- `https://你的项目名.onrender.com/admin.html`（会弹出用户名密码框）

访问根网址 `https://你的项目名.onrender.com` 也会自动跳转到顾客点餐页。

## 环境变量别忘了

如果这是全新仓库/服务，记得在 Render 的 **Environment Variables** 里加：
- `ADMIN_USER` = 你的后台用户名
- `ADMIN_PASSWORD` = 你的后台密码

不设置的话默认是 `admin` / `changeme`，任何人都能猜到进去改菜单。
