# 免费上线：GitHub Pages + Supabase

[English instructions](DEPLOY.md)

网页部署到 GitHub Pages；账号、账本和结算保存在 Supabase Free 项目。无需开启 Render、购买服务器或购买域名。本项目不会自动升级付费套餐。

## 1. 初始化 Supabase 数据库

打开当前项目的 [SQL Editor](https://supabase.com/dashboard/project/tzmgnrgeotahugglvces/sql/new)，将下列文件的**全部内容**复制到编辑器，点击 **Run**：

[`supabase/migrations/202610280001_sharecost.sql`](supabase/migrations/202610280001_sharecost.sql)

该脚本会创建独立的 `sharecost_private` schema、账本表和 `public.sharecost_api` 接口。它不删除原有记录；重复运行不会清空账本。浏览器角色没有直接读写表的权限；每个接口调用都由数据库核验当前登录身份、成员关系和操作权限。表也启用了 RLS，匿名访问不允许执行账本接口。

不要把 `sharecost_private` 加入 Data API 的 exposed schemas。

## 2. 配置注册确认邮件的跳转地址

打开 [Authentication → URL Configuration](https://supabase.com/dashboard/project/tzmgnrgeotahugglvces/auth/url-configuration)。将 **Site URL** 设置为：

```text
https://jialongwang1201.github.io/ShareCost/
```

在 **Redirect URLs** 中也加入同一个地址并保存。保留邮箱确认开启；网页会提示新成员查收确认邮件，然后再登录。你提供的项目目前已开启邮箱注册和邮箱确认。

## 3. 启用 GitHub Pages

以 `JialongWang1201` 登录 GitHub，打开 [ShareCost → Settings → Pages](https://github.com/JialongWang1201/ShareCost/settings/pages)。在 **Build and deployment → Source** 中选择 **GitHub Actions**。

在 [Actions](https://github.com/JialongWang1201/ShareCost/actions) 中找到 **Validate and deploy ShareCost**，运行或重新运行工作流。通过后，部署地址是：

```text
https://jialongwang1201.github.io/ShareCost/
```

以上地址是预期部署地址，只有工作流成功才代表网站已发布。之后推送到 `main` 会自动运行测试、构建并更新网页。

## 配置与数据

- 项目 URL 与 publishable key 已填写在 [`web/config.js`](web/config.js)，这是允许用于浏览器的公开配置。
- 不需要把 `sb_secret_...`、service-role key 或数据库密码放进网页、GitHub Actions 或本仓库。
- GitHub Pages 上传的内容只包含 `dist/` 里的网页资源，不包含本地数据库。
- 原来的 `./start.sh` 仍使用本机 Python 和 SQLite；线上网站使用独立的 Supabase 账号和数据。两者不自动迁移或同步。
- Supabase 管理连接用于建表和修改设置，publishable key 用于网页访问，二者不是同一种权限。如果要由助手直接执行初始化，需授权 Supabase 管理连接；仅有公开 key 时可以自己在 SQL Editor 执行上面的脚本。

## 验证

```sh
npm ci
npm run build
npm test
npm run check:cloud
```

`check:cloud` 仅检查公开项目设置及匿名访问是否被拒绝，不注册账户、不创建账单。若显示 RPC 尚未初始化，先执行第 1 步。完整多人上线验证应在执行脚本后，用两个真实账号加入同一账本并检查分摊和结算。

本地预览云端构建：

```sh
python3 -m http.server 8080 --directory dist
```

访问 `http://127.0.0.1:8080`。如需测试邮箱确认回跳，需将这个本地地址额外加入 Supabase 的 Redirect URLs。

免费套餐仍有额度和低活跃暂停限制，详情见 [Supabase Free](https://supabase.com/pricing)。保持组织为 Free，无需开通收费服务。
