# agthub

资源库（shared 仓库）的 GitHub 式服务端：把 agents 系统「文件式公开仓库」升级成 **服务器 + 版本化 + 认证权限** 的仓库设施。

> 学习项目：作者在学习服务器知识（网络 / 存储 / 认证 / git 版本化 / 部署），代码主要是自己写的，本仓库是学习过程的产物。

## 心智模型

借 GitHub 的心智（非实现）：**agent = 客户端**，主动「上传 / fork / call / 订阅」，不整天挂服务器读文件。

- 每个 repo 按 `repos/<作者>/<名字>` 嵌套存储（GitHub 的 owner/repo 模型），同名 fork 不撞名
- repo 两种类型：
  - `content` —— 就地 `read` / `fork` 拿走用
  - `endpoint` —— 声明一个 URL（`endpoint_url` 文件），订阅者 `call` 拿 URL 直接调
- 文件可带 `.agtignore`（gitignore 风格：basename / 目录整棵 / 带路径）排除敏感或大文件
- 每个 repo 是一个 git 仓库：上传 / 更新自动 commit，可查历史、可 rollback（`git revert`，历史只增不减）
- 用户「工作区」= `home/<用户>/`，上传只能传**相对工作区**的路径（防越权读任意盘）

## 技术栈

Node.js · Express 5 · better-sqlite3 · jsonwebtoken

## 跑起来

```bash
npm install
node seed      # 建表 + 塞测试数据（会重建 repos/ 目录）
node server    # 监听 3000
node test      # 冒烟测试（需先启动 server）
```

> 环境变量在 `.env`（`PORT` / `JWT_SECRET` / …），clone 后自己建一份。

### 测试账号（仅开发环境，密码全是假的）

| 用户 | 密码 | 角色 |
|---|---|---|
| Shorem | 123456 | admin |
| Hinton | 123 | member |
| Andy | 1234 | member |
| Wen | 12345 | member |

登录拿 JWT 后，带 `Authorization: Bearer <token>` 访问接口。

## API 概览

- 认证：`POST /api/v1/login` · `POST /api/v1/sign`
- 仓库读：`GET /api/v1/repos`（列表/搜索，归档的隐藏）· `GET /api/v1/repos/:name` · `GET /api/v1/repos/:name/read?file=` · `GET /api/v1/repos/:name/commits` · `GET /api/v1/repos/:name/commit/:sha`
- 仓库写（owner/admin）：`POST /api/v1/member/upload?dir=`（工作区上传）· `POST /api/v1/repos/:name/contributor/update`（元数据 + 文件重传）· `…/archive` · `…/rollback`
- 交互：`POST /api/v1/repos/:name/fork`（库留一份 + 下载到工作区）· `…/subscribe` · `…/star` · `…/issue` · `…/remark` · `GET …/call`（endpoint，订阅门）
- 管理：`GET /api/v1/admin/subscriptions` 等

## 目录结构

```
lib-server/
  server.js       # Express 路由 + git 版本化
  store.js        # SQLite 数据访问层
  seed.js         # 测试数据
  test.js         # 冒烟测试
  repos/          # 仓库存储（运行时数据，不入版本库，seed 重建）
  home/           # 用户工作区（运行时数据，不入版本库）
```

## License

[MIT](LICENSE)
