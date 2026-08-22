require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const Database = require('better-sqlite3');
const DATA_ROOT = process.env.LIB_ROOT || __dirname

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = new Database(path.join(DATA_ROOT, 'lib.db'));
const baseAddress = path.join(DATA_ROOT, 'repos')
/** 上传工作区根：repos 同级 home/ 下，每个用户一个子目录（agent 视为独立用户） */
const uploadRoot = path.join(DATA_ROOT, 'home');

const PORT = process.env.PORT || 3000;

const jwt = require('jsonwebtoken')
const secret = process.env.JWT_SECRET;
const options = { expiresIn: process.env.JWT_SECRET_IN || '1h'};
const store = require('./store')

/**
 * JWT 认证中间件：验 `Authorization: Bearer <token>`，成功把解码结果挂到 req.user
 * 空/缺 token → 401；过期 → 401；无效 → 403
 */
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if(!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Unauthorized: Missing or invalid token format'
        });
    }
    const token = authHeader.split(' ')[1];
    if(!token) return res.status(401).json({ error: 'Unauthorized: Missing token'})
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch(error) {
        if(error.name === 'TokenExpiredError') {
            return res.status(401)
                .json({ error: 'Unauthorized: Token expired' });
        }
        return res.status(403)
            .json({ error: 'Forbidden: Invalid token' });
    }
};

/**
 * 写面鉴权：repo owner 或 admin 才能过（挂在 /repos/:name/contributor 前缀下）
 * 须在 authenticateJWT 之后用（req.user 已填充）
 */
const contributorAuth = (req, res, next) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        if(row.author === userName || req.user.role === 'admin') {
            next();
        } else {
            return res.status(403).json({ error: 'Forbidden: Contributors only' });
        }
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
}

/**
 * 管理员鉴权：要求 req.user.role === 'admin'（挂在 /api/v1/admin 前缀下）
 * 须在 authenticateJWT 之后用（依赖 req.user 已由它填充）
 */
const adminAuth = (req, res, next) => {
    if(!req.user) {
        return res.status(401)
            .json({ error: 'Unauthorized: Login first' })
    }
    if(req.user.role === 'admin') {
        next();
    } else {
        return res.status(403)
            .json({ error: 'Forbidden: Admin access required' })
    }
};

// 所有 /repos 路由都要登录（前缀统一挂 authenticateJWT）
app.use('/api/v1/repos', authenticateJWT);

/**
 * 模糊匹配搜索资源库
 * @route GET /api/v1/repos
 * @param {string} req.query.q - 可选，搜索词
 * @returns {Object} 200 - 库对象
 * @returns {Object} 500 - 服务器错误
 */
app.get('/api/v1/repos', (req, res) => {
    const keyword = req.query.q;
    let rows;
    try {
        if(keyword) {
            const searchTerm = `%${keyword}%`;
            const stmt = db.prepare(`
                SELECT * FROM repos
                WHERE archived = 0
                AND (name LIKE ?
                     OR author LIKE ?
                     OR tags LIKE ?)
            `);
            rows = stmt.all(searchTerm, searchTerm, searchTerm);
        } else {
            const stmt = db.prepare(`SELECT * FROM repos WHERE archived = 0`);
            rows = stmt.all();
        }
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
    res.json(rows);
});

/**
 * @route GET /api/v1/repos/:name
 * @param {string} req.param.name - 库名
 * @returns {Object} 200 - 库基本信息
 * @returns {Object} 404 - 库不存在
 * @returns {Object} 500 - 服务器错误
 */
app.get('/api/v1/repos/:name', (req, res) => {
    const repoName = req.params.name;
    try {
        const stmt = db.prepare(`SELECT * FROM repos WHERE name = ?`);
        const row = stmt.get(repoName);
        if(row) {
            return res.status(200).json(row);
        } else {
            return res.status(404).json({ error: 'Repository not found' });
        }
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route GET /api/v1/repos/:name/read
 * @param {string} req.params.name - 被查询的库
 * @param {string} req.query.file - 被查询文件夹/文件的地址
 * @returns {Object} 200 - 文件夹结构/文件内容
 * @returns {Object} 403 - 区域不可访问
 * @returns {Object} 404 - 库/文件夹/文件不存在
 * @returns {Object} 500 - 服务器错误
 */
app.get('/api/v1/repos/:name/read', (req, res) => {
    const repoName = req.params.name;
    const fileName = req.query.file;
    // 存储按作者分目录（repos/<author>/<name>），先查库定位作者
    const row = store.find('repos', 'name', repoName);
    if(!row) return res.status(404).json({ error: 'Repository not found' });
    const baseDir = path.join(baseAddress, row.author, repoName);
    if(!fileName) {
        const files = fs.readdirSync(baseDir);
        return res.status(200).json({ files: files });
    }
    const requestedPath = path.join(baseDir, fileName);
    const resolved = path.resolve(requestedPath);
    if(!resolved.startsWith(baseDir)) {
        return res.status(403).json({ error: 'Forbidden: Personal field' });
    }

    try {
        const stats = fs.statSync(resolved);
        if(stats.isDirectory()) {
            const files = fs.readdirSync(resolved);
            return res.status(200).json({ files: files });
        }
        const content = fs.readFileSync(resolved, 'utf-8');
        return res.status(200).send({ content: content });
    } catch(error) {
        if(error.code === 'ENOENT') {
            return res.status(404).json({ error: 'Path not found' });
        }
        return res.status(500).json({ error: error.message });
    }
})

/**
 * @route POST /api/v1/repos/:name/subscribe
 * @param {string} req.params.name - 被订阅的库
 * @param {string} req.user.userName - 请求订阅的用户名
 * @param {Object} 201 - 订阅成功
 * @param {Object} 404 - 库不存在
 * @param {Object} 500 - 服务器错误
 */
app.post('/api/v1/repos/:name/subscribe', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const row = store.find('repos', 'name', repoName );
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        store.insert('subscriptions', { repo_name: repoName, user_name: userName })
        return res.status(201).json({ info: 'subscribed' });
        
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route DELETE /api/v1/repos/:name/subscribe
 * @param {string} req.params.name - 被退订的库
 * @returns {Object} 200 - 退订成功
 * @returns {Object} 404 - 库不存在 / 本来就未订阅
 * @returns {Object} 500 - 服务器错误
 */
app.delete('/api/v1/repos/:name/subscribe', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        const info = store.multiRemove('subscriptions',
            ['repo_name', 'user_name'], [repoName, userName]);
        if(info.changes === 0) {
            return res.status(404).json({ error: 'not subscribed' });
        }
        return res.status(200).json({ info: 'unsubscribed' });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route POST /api/v1/repos/:name/star
 * @param {string} req.params.name - 被收藏的库
 * @param {string} req.user.userName - 请求收藏的用户名（取 token 身份，不信任请求体）
 * @param {Object} 201 - 收藏成功
 * @param {Object} 404 - 库不存在
 * @param {Object} 500 - 服务器错误
 */
app.post('/api/v1/repos/:name/star', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        store.insert('stars', { repo_name: repoName, user_name: userName });
        return res.status(201).json({ info: 'starred' });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route DELETE /api/v1/repos/:name/star
 * @param {string} req.params.name - 被取消收藏的库
 * @returns {Object} 200 - 取消收藏成功
 * @returns {Object} 404 - 库不存在 / 本来就未收藏
 * @returns {Object} 500 - 服务器错误
 */
app.delete('/api/v1/repos/:name/star', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        const info = store.multiRemove('stars',
            ['repo_name', 'user_name'], [repoName, userName]);
        if(info.changes === 0) {
            return res.status(404).json({ error: 'not starred' });
        }
        return res.status(200).json({ info: 'unstarred' });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route POST /api/v1/repos/:name/issue
 * @param {string} req.params.name - 被提 issue 的库
 * @param {string} req.body.content - issue 内容
 * @returns {Object} 201 - 提交成功
 * @returns {Object} 400 - 内容为空
 * @returns {Object} 404 - 库不存在
 * @returns {Object} 500 - 服务器错误
 */
app.post('/api/v1/repos/:name/issue', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        if(!req.body.content) {
            return res.status(400).json({ error: 'content empty' });
        }
        store.insert('issues', {
            repo_name: repoName,
            user_name: userName,
            content: req.body.content,
            created_at: new Date().toISOString()
        });
        return res.status(201).json({ info: 'issue submitted' });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route GET /api/v1/repos/:name/issues
 * @param {string} req.params.name - 被查询的库
 * @returns {Object} 200 - issue 列表
 * @returns {Object} 404 - 库不存在
 * @returns {Object} 500 - 服务器错误
 */
app.get('/api/v1/repos/:name/issues', (req, res) => {
    const repoName = req.params.name;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        const data = store.multiFind('issues', ['repo_name'], [repoName]);
        return res.status(200).json({ issues: data });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route POST /api/v1/repos/:name/remark
 * @param {string} req.params.name - 被提 remark 的库
 * @param {string} req.body.content - remark 内容
 * @returns {Object} 201 - 提交成功
 * @returns {Object} 400 - 内容为空
 * @returns {Object} 404 - 库不存在
 * @returns {Object} 500 - 服务器错误
 */
app.post('/api/v1/repos/:name/remark', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        if(!req.body.content) {
            return res.status(400).json({ error: 'content empty' });
        }
        store.insert('remarks', {
            repo_name: repoName,
            user_name: userName,
            content: req.body.content,
            created_at: new Date().toISOString()
        });
        return res.status(201).json({ info: 'remark submitted' });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route GET /api/v1/repos/:name/remarks
 * @param {string} req.params.name - 被查询的库
 * @returns {Object} 200 - remark 列表
 * @returns {Object} 404 - 库不存在
 * @returns {Object} 500 - 服务器错误
 */
app.get('/api/v1/repos/:name/remarks', (req, res) => {
    const repoName = req.params.name;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        const data = store.multiFind('remarks', ['repo_name'], [repoName]);
        return res.status(200).json({ remarks: data });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * fork：在你的名下复制一份（同名，存储按作者分目录）+ 下载到你的工作区
 * - 库（agthub）留一份：repos/<你>/<name>，登记为你自己的 repo
 * - 工作区留一份：home/<你>/<name>，可直接改，改完 update 重传
 * @route POST /api/v1/repos/:name/fork
 * @param {string} req.params.name - 被 fork 的库
 * @param {string} req.user.userName - 请求 fork 的用户名（取 token 身份）
 * @returns {Object} 201 - fork 成功
 * @returns {Object} 200 - 你名下已有同名 fork
 * @returns {Object} 404 - 库不存在
 */
app.post('/api/v1/repos/:name/fork', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        // 同名不同作者（UNIQUE(name, author)）：你名下已有同名 → already forked
        const existing = store.multiFind('repos', ['name', 'author'], [repoName, userName]);
        if(existing.length > 0) {
            return res.status(200).json({ info: 'already forked', repo: existing[0] });
        }
        const srcDir = path.join(baseAddress, row.author, repoName);
        // 库留一份（你的名下同名目录）
        const agthubDst = path.join(baseAddress, userName, repoName);
        // 下载到自己工作区：home/<你>/<name>
        const wsDst = path.join(uploadRoot, userName, repoName);
        if(fs.existsSync(srcDir)) {
            fs.mkdirSync(path.dirname(agthubDst), { recursive: true });
            fs.cpSync(srcDir, agthubDst, { recursive: true });
            fs.mkdirSync(path.dirname(wsDst), { recursive: true });
            fs.cpSync(srcDir, wsDst, { recursive: true });
        }
        store.insert('repos', { name: repoName, author: userName,
            tags: row.tags, version: row.version, type: row.type })
        return res.status(201).json({ info: 'forked'});
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * 调用接口：content 库就地 read/fork；endpoint 库校验订阅后返回声明的端点 URL（订阅者自调）
 * @route GET /api/v1/repos/:name/call
 * @returns {Object} 200 - { url }（endpoint 库）
 * @returns {Object} 403 - 未订阅且非 owner/admin
 * @returns {Object} 404 - 库不存在 / content 库
 */
app.get('/api/v1/repos/:name/call', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        if(row.type === 'content') {
            return res.status(404).json({ error: 'Content repo: use read or fork' });
        }
        // 订阅门：订阅者 / owner / admin 可用，否则 403
        const subscribed = store.multiFind('subscriptions',
            ['repo_name', 'user_name'], [repoName, userName]).length > 0;
        const isOwner = row.author === userName;
        const isAdmin = req.user.role === 'admin';
        if(!subscribed && !isOwner && !isAdmin) {
            return res.status(403).json({ error: 'Forbidden: subscribe first' });
        }
        // endpoint 的 URL 声明在 repo 目录的 endpoint_url 文件里（upload 时检测并置 type=endpoint）
        const endpointFile = path.join(baseAddress, row.author, repoName, 'endpoint_url');
        if(!fs.existsSync(endpointFile)) {
            return res.status(500).json({ error: 'endpoint_url file missing' });
        }
        const url = fs.readFileSync(endpointFile, 'utf-8').trim();
        return res.status(200).json({ url: url });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * 查看 repo 的 git 提交历史（新→旧）
 * @route GET /api/v1/repos/:name/commits
 * @returns {Object} 200 - { commits: [{ sha, author, date, message }] }（无历史 → 空数组）
 */
app.get('/api/v1/repos/:name/commits', (req, res) => {
    const repoName = req.params.name;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) return res.status(404).json({ error: 'Repository not found' });
        const repoDir = path.join(baseAddress, row.author, repoName);
        let head;
        try { head = gitRun(repoDir, ['rev-parse', '--verify', 'HEAD']); }
        catch { return res.status(200).json({ commits: [] }); }   // 还没 commit 过
        const out = gitRun(repoDir, ['log', '--format=%H|%an|%ad|%s', '--date=iso']);
        const commits = out.split('\n').filter(Boolean).map(line => {
            const [sha, author, date, ...msg] = line.split('|');
            return { sha, author, date, message: msg.join('|') };
        });
        return res.status(200).json({ commits });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * 查看某次提交的变更内容（提交信息 + 文件统计 + diff）
 * @route GET /api/v1/repos/:name/commit/:sha
 * @returns {Object} 200 - { diff: 原始文本 }
 * @returns {Object} 404 - sha 不存在 / repo 不存在
 */
app.get('/api/v1/repos/:name/commit/:sha', (req, res) => {
    const repoName = req.params.name;
    const sha = req.params.sha;
    try {
        const row = store.find('repos', 'name', repoName);
        if(!row) return res.status(404).json({ error: 'Repository not found' });
        const repoDir = path.join(baseAddress, row.author, repoName);
        const diff = gitRun(repoDir, ['show', '--format=fuller', '--stat', sha]);
        return res.status(200).json({ diff });
    } catch(error) {
        return res.status(404).json({ error: (error.stderr || error.message).trim() });
    }
});

// /member 前缀需要登录
app.use('/api/v1/member', authenticateJWT);

/**
 * 查看自己的订阅
 * @route GET /api/v1/member/subscriptions
 * @returns {Object} 200 - { data: 订阅行数组 }
 */
app.get('/api/v1/member/subscriptions', (req, res) => {
    const userName = req.user.userName;
    try {
        const rows = store.multiFind('subscriptions', ['user_name'], [userName]);
        return res.status(200).json({ data: rows });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * 查看自己的收藏
 * @route GET /api/v1/member/stars
 * @returns {Object} 200 - { data: 收藏行数组 }
 */
app.get('/api/v1/member/stars', (req, res) => {
    const userName = req.user.userName;
    try {
        const rows = store.multiFind('stars', ['user_name'], [userName]);
        return res.status(200).json({ data: rows });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/** 读 repo 源目录的 .agtignore，返回要排除的相对路径/目录（# 开头为注释） */
function _readIgnorePatterns(dir) {
    const ignoreFile = path.join(dir, '.agtignore');
    if(!fs.existsSync(ignoreFile)) return [];
    return fs.readFileSync(ignoreFile, 'utf-8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
}

/**
 * 相对路径是否命中忽略规则（gitignore 风格）：
 * - 目录规则（结尾带 /，如 `node_modules/`）→ 整棵排除
 * - 带路径规则（如 `data/secret.json`）→ 整条匹配或目录前缀
 * - 不带斜杠规则（如 `secret.json`）→ 按 basename 匹配任意层级
 */
function _isIgnored(relPath, patterns) {
    const norm = relPath.split(path.sep).join('/');
    return patterns.some(p => {
        const isDir = p.endsWith('/') || p.endsWith('\\');
        const pat = p.replace(/[\\/]+$/, '').split(path.sep).join('/');
        if(isDir) {
            return norm === pat || norm.startsWith(pat + '/');
        }
        if(pat.includes('/')) {
            return norm === pat || norm.startsWith(pat + '/');
        }
        return norm.split('/').pop() === pat;
    });
}

/**
 * 在 repo 目录执行 git 命令（子进程调外部 git）。
 * - author 传了就内联 `-c user.name/user.email`（命令级作者，不落全局/本地配置）
 * - 用 execFileSync + 参数数组、不经过 shell → 作者名带空格/特殊字符也安全
 * @returns {string} stdout（去掉尾随换行）
 */
function gitRun(repoDir, args, author) {
    const fullArgs = [];
    if(author) {
        fullArgs.push('-c', `user.name=${author}`, '-c', `user.email=${author}@agthub`);
    }
    fullArgs.push(...args);
    return execFileSync('git', fullArgs, { cwd: repoDir, encoding: 'utf-8' }).trim();
}

/**
 * 确保 repo 目录是 git 仓库，且工作树有改动就自动 commit（作者内联）。
 * 没改动（status --porcelain 为空）就跳过 → 幂等重传不会制造空 commit
 */
function ensureGitRepo(repoDir, author) {
    if(!fs.existsSync(path.join(repoDir, '.git'))) {
        gitRun(repoDir, ['init', '-q']);
    }
    if(gitRun(repoDir, ['status', '--porcelain'])) {
        gitRun(repoDir, ['add', '-A']);
        gitRun(repoDir, ['commit', '-q', '-m', 'auto commit'], author);
    }
}

/** cpSync 的 filter：排除 .git（git 历史不随内容走）和 .agtignore 命中的路径 */
function copyFilter(src, ignorePatterns) {
    return (p) => {
        const norm = path.relative(src, p).split(path.sep).join('/');
        if(norm === '.git' || norm.startsWith('.git/')) return false;
        return !_isIgnored(path.relative(src, p), ignorePatterns);
    };
}

/**
 * 上传 repo：把用户工作区里的目录复制进库
 * - dir：相对用户工作区的路径（绝对路径直接拒绝，防越权读任意盘）
 * - 源目录下有 endpoint_url 文件 → type=endpoint；否则 content
 * - .agtignore 列出要排除的文件/目录（含整棵子目录）
 * - 缺 README.md 不阻断，只回 warning
 * - 先复制到临时目录再改名（rename 原子），文件就位后才入库，防止上传中途被扫到半成品
 * @route POST /api/v1/member/upload?dir=<源目录>&version=<可选>&tags=<可选>
 * @returns {Object} 201 - { info, repo, type, warning? }
 * @returns {Object} 409 - repo 已存在（用 update）
 * @returns {Object} 403 - dir 越出用户工作区
 */
app.post('/api/v1/member/upload', (req, res) => {
    const userName = req.user.userName;
    const dir = req.query.dir;
    const version = req.query.version || '0.0.1';
    const tags = req.query.tags || null;
    try {
        if(!dir) {
            return res.status(400).json({ error: 'dir required' });
        }
        const user_workspace = path.join(uploadRoot, userName);
        // 只接受相对用户工作区的路径；绝对路径直接拒绝（防越权读任意盘）
        if(path.isAbsolute(dir)) {
            return res.status(403).json({ error: 'Forbidden: use relative path to your workspace' });
        }
        const src = path.resolve(user_workspace, dir);
        if(!src.startsWith(user_workspace)) {
            return res.status(403).json({ error: 'Forbidden: outside workspace' });
        }
        if(!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
            return res.status(404).json({ error: 'Source dir not found' });
        }
        const repoName = path.basename(src);
        const dup = store.multiFind('repos', ['name', 'author'], [repoName, userName]);
        if(dup.length > 0) {
            return res.status(409).json({ error: 'Repo exists, use update' });
        }
        const dst = path.join(baseAddress, userName, repoName);
        if(fs.existsSync(dst)) {
            return res.status(409).json({ error: 'Repo dir exists' });
        }
        const ignorePatterns = _readIgnorePatterns(src);
        const type = fs.existsSync(path.join(src, 'endpoint_url')) ? 'endpoint' : 'content';
        const warning = fs.existsSync(path.join(src, 'README.md'))
            ? null : 'missing README.md';

        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const tmp = path.join(path.dirname(dst), `.upload-${repoName}-${Date.now()}`);
        try {
            fs.cpSync(src, tmp, { recursive: true, filter: copyFilter(src, ignorePatterns) });
            fs.renameSync(tmp, dst);
        } catch(copyErr) {
            fs.rmSync(tmp, { recursive: true, force: true });
            throw copyErr;
        }
        ensureGitRepo(dst, userName);   // 建 git 仓库 + 首个 commit（文件就位后、入库前）
        store.insert('repos', { name: repoName, author: userName, tags, version, type });
        return res.status(201).json({
            info: 'uploaded', repo: repoName, type,
            ...(warning ? { warning } : {})
        });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

// 写面：/repos/:name/contributor 前缀挂 contributorAuth（owner/admin 才能过）
app.use('/api/v1/repos/:name/contributor', contributorAuth);

/**
 * 返回订阅者和订阅数量
 * @route GET /api/v1/repos/:name/contributor/subscribers
 * @returns {Object} 200 - { subscribers, count }
 */
app.get('/api/v1/repos/:name/contributor/subscribers', (req, res) => {
    const repoName = req.params.name;
    try {
        const rows = store.multiFind('subscriptions', ['repo_name'], [repoName]);
        return res.status(200).json({ subscribers: rows, count: rows.length });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * 返回收藏者和收藏数量
 * @route GET /api/v1/repos/:name/contributor/stars
 * @returns {Object} 200 - { stars, count }
 */
app.get('/api/v1/repos/:name/contributor/stars', (req, res) => {
    const repoName = req.params.name;
    try {
        const rows = store.multiFind('stars', ['repo_name'], [repoName]);
        return res.status(200).json({ stars: rows, count: rows.length });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * 更新 repo：元数据（body 的 version/tags/type）和/或文件重传（?dir= 工作区相对路径）
 * - 文件重传 = 用工作区目录内容**替换** repo 目录（应用 .agtignore），等价「重新上传」
 * - GitHub 模型：内容靠 push（本地改→提交→推送），元数据靠独立 settings；这里用「目录替换 + git 自动 commit」顶替 push
 * @route POST /api/v1/repos/:name/contributor/update?dir=<可选，工作区相对路径>
 * @param {Object} req.body - 可含 version / tags / type（type 须是 content|endpoint）
 * @returns {Object} 200 - { info: 'updated' }
 */
app.post('/api/v1/repos/:name/contributor/update', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    const dir = req.query.dir;
    try {
        const values = {};
        if(req.body.version !== undefined) values.version = String(req.body.version);
        if(req.body.tags !== undefined) values.tags = req.body.tags;
        if(req.body.type !== undefined) {
            if(!['content', 'endpoint'].includes(req.body.type)) {
                return res.status(400).json({ error: 'type must be content|endpoint' });
            }
            values.type = req.body.type;
        }
        // 文件重传：工作区目录整体替换 repo 目录
        if(dir) {
            const user_workspace = path.join(uploadRoot, userName);
            if(path.isAbsolute(dir)) {
                return res.status(403).json({ error: 'Forbidden: use relative path to your workspace' });
            }
            const src = path.resolve(user_workspace, dir);
            if(!src.startsWith(user_workspace)) {
                return res.status(403).json({ error: 'Forbidden: outside workspace' });
            }
            if(!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
                return res.status(404).json({ error: 'Source dir not found' });
            }
            const patterns = _readIgnorePatterns(src);
            fs.mkdirSync(path.join(baseAddress, userName), { recursive: true });
            const dst = path.join(baseAddress, userName, repoName);
            const tmp = path.join(baseAddress, userName, `.update-${repoName}-${Date.now()}`);
            try {
                fs.cpSync(src, tmp, { recursive: true, filter: copyFilter(src, patterns) });
                // 替换内容但保留 .git（git 历史不随重传丢失）
                for(const entry of fs.readdirSync(dst)) {
                    if(entry !== '.git') {
                        fs.rmSync(path.join(dst, entry), { recursive: true, force: true });
                    }
                }
                for(const entry of fs.readdirSync(tmp)) {
                    fs.renameSync(path.join(tmp, entry), path.join(dst, entry));
                }
                fs.rmSync(tmp, { recursive: true, force: true });
            } catch(copyErr) {
                fs.rmSync(tmp, { recursive: true, force: true });
                throw copyErr;
            }
            ensureGitRepo(dst, userName);   // 有改动就自动 commit（历史继续）
        }
        if(Object.keys(values).length === 0 && !dir) {
            return res.status(400).json({ error: 'nothing to update' });
        }
        if(Object.keys(values).length > 0) {
            const info = store.update('repos', values, ['name', 'author'], [repoName, userName]);
            if(info.changes === 0) {
                return res.status(404).json({ error: 'Repository not found' });
            }
        }
        return res.status(200).json({ info: 'updated' });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * 归档 repo（archived=1）：从公开列表/搜索隐藏；按名直接查仍可见（archived 字段）
 * @route POST /api/v1/repos/:name/contributor/archive
 * @returns {Object} 200 - { info: 'archived' }
 */
app.post('/api/v1/repos/:name/contributor/archive', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    try {
        const info = store.update('repos', { archived: 1 },
            ['name', 'author'], [repoName, userName]);
        if(info.changes === 0) {
            return res.status(404).json({ error: 'Repository not found' });
        }
        return res.status(200).json({ info: 'archived' });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * 回滚到目标提交：`git revert` 追加一个撤销提交（历史只增不减）
 * - 强制清场：先 reset --hard + clean -fd 丢弃未提交残留（revert 要求干净工作区）
 * - revert 冲突会停在冲突态 → 自动 abort 清理，把原始错误抛给调用方
 * @route POST /api/v1/repos/:name/contributor/rollback
 * @param {Object} req.body - { sha: 要撤销的提交 }
 * @returns {Object} 200 - { info: 'reverted' }
 * @returns {Object} 400 - 无历史 / sha 缺失 / git 报错
 */
app.post('/api/v1/repos/:name/contributor/rollback', (req, res) => {
    const repoName = req.params.name;
    const userName = req.user.userName;
    const sha = req.body.sha;
    try {
        if(!sha) return res.status(400).json({ error: 'sha required' });
        const row = store.find('repos', 'name', repoName);
        if(!row) return res.status(404).json({ error: 'Repository not found' });
        const repoDir = path.join(baseAddress, row.author, repoName);
        if(!fs.existsSync(path.join(repoDir, '.git'))) {
            return res.status(400).json({ error: 'repo has no git history' });
        }
        // 强制清场：丢弃未提交残留
        gitRun(repoDir, ['reset', '--hard', 'HEAD']);
        gitRun(repoDir, ['clean', '-fd']);
        try {
            gitRun(repoDir, ['revert', '--no-edit', sha], userName);
        } catch(revertErr) {
            try { gitRun(repoDir, ['revert', '--abort']); } catch { /* 清理失败就留给下个动作 */ }
            throw revertErr;
        }
        return res.status(200).json({ info: 'reverted' });
    } catch(error) {
        return res.status(400).json({ error: (error.stderr || error.message).trim() });
    }
});

app.use('/api/v1/admin', authenticateJWT, adminAuth);

/**
 * @route POST /api/v1/sign
 * @param {string} req.body.userName - 用户名（必填）
 * @param {string} req.body.password - 密码（必填）
 * @param {string} req.body.alias - 别名（可选）
 * @returns {Object} 201 - 注册成功（role 固定 member）
 * @returns {Object} 400 - 用户名或密码为空
 * @returns {Object} 500 - 服务器错误（用户名重复等）
 */
app.post('/api/v1/sign', (req, res) => {
    const { userName, alias, password } = req.body;
    try {
        if(!userName || !password) {
            return res.status(400).json({ error: 'name or password empty' });
        }
        store.insert('users', { name: userName, alias: alias,
            role: 'member', password: password,});
        return res.status(201).json({ info: 'sign succeeded' });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route POST /api/v1/login
 * @param {string} req.body.userName - 用户名
 * @param {string} req.body.password - 密码
 * @returns {Object} 200 - 登录成功，返回 { token }
 * @returns {Object} 401 - 密码不对 / 用户不存在
 * @returns {Object} 500 - 服务器错误
 */
app.post('/api/v1/login', (req, res) => {
    const { userName, password } = req.body;
    const user = store.find('users', 'name', userName);
    try {
        if(password === user.password) {
            const payload = { userID: user.id, userName: user.name, role: user.role };
            const token = jwt.sign(payload, secret, options);
            return res.status(200).json({ token: token });
        }
        return res.status(401).json({ error: 'Invalid credentials' });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route GET /api/v1/admin/subscriptions
 * @param {string} req.query.repo - 被查询库
 * @param {string} req.query.user - 被查询用户
 * @returns {Object} 200 - 订阅表/某库订阅/某用户订阅
 * @returns {Object} 500 - 服务器错误
 */
app.get('/api/v1/admin/subscriptions', (req, res) => {
    const { repo, user } = req.query;
    try {
        const fields = [];
        const values = [];
        if(repo) {
            fields.push('repo_name')
            values.push(repo);
        }
        if(user) {
            fields.push('user_name')
            values.push(user);
        }
        const data = store.multiFind('subscriptions', fields, values);
        return res.status(200).json({ 'subscriptions': data });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

/**
 * @route GET /api/v1/admin/stars
 * @param {string} req.query.repo - 可选，按库过滤
 * @param {string} req.query.user - 可选，按用户过滤
 * @returns {Object} 200 - 收藏表 / 某库收藏 / 某用户收藏
 * @returns {Object} 500 - 服务器错误
 */
app.get('/api/v1/admin/stars', (req, res) => {
    const { repo, user } = req.query;
    try {
        const fields = [];
        const values = [];
        if(repo) {
            fields.push('repo_name');
            values.push(repo);
        }
        if(user) {
            fields.push('user_name')
            values.push(user);
        }
        const data = store.multiFind('stars', fields, values);
        return res.status(200).json({ 'stars': data });
    } catch(error) {
        return res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
})