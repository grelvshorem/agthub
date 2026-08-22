/**
 * 冒烟测试：对本地 lib-server 全流程跑一遍
 * （注册/登录/订阅/收藏/fork/issue/remark/call/member/contributor/upload + 各 4xx 分支）
 * 前置：`node server` 已在 3000 端口运行；本脚本会先 seed.reset() 清库重建
 */
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
const store = require('./store');
const seed = require('./seed');

let pass = 0, fail = 0;
function t(name, cond, extra) {
    if(cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function api(pathStr, { method = 'GET', token, body } = {}) {
    const res = await fetch(BASE + pathStr, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': 'Bearer ' + token } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
}

async function run() {
    seed.reset();

    // ---- 登录 ----
    const admin    = (await api('/api/v1/login', { method: 'POST', body: { userName: 'Shorem', password: '123456' } })).data.token;
    const andy     = (await api('/api/v1/login', { method: 'POST', body: { userName: 'Andy', password: '1234' } })).data.token;
    const hinton   = (await api('/api/v1/login', { method: 'POST', body: { userName: 'Hinton', password: '123' } })).data.token;
    const wen      = (await api('/api/v1/login', { method: 'POST', body: { userName: 'Wen', password: '12345' } })).data.token;
    await api('/api/v1/sign', { method: 'POST', body: { userName: 'NewMember', password: 'newmember' } });
    const newmember = (await api('/api/v1/login', { method: 'POST', body: { userName: 'NewMember', password: 'newmember' } })).data.token;
    t('login: admin/andy/hinton/wen/newmember 都拿到 token', !!admin && !!andy && !!hinton && !!wen && !!newmember);

    // 密码错误 / 未注册登录
    t('密码错 → 401', (await api('/api/v1/login', { method: 'POST', body: { userName: 'Wen', password: 'pswd' } })).status === 401);

    // ---- 订阅 / 收藏 / fork ----
    await api('/api/v1/repos/balatro_3p_game/subscribe', { method: 'POST', token: andy });
    await api('/api/v1/repos/balatro_3p_game/subscribe', { method: 'POST', token: andy }); // 重复订阅（幂等）
    await api('/api/v1/repos/bills/subscribe', { method: 'POST', token: andy });
    await api('/api/v1/repos/bills/star', { method: 'POST', token: andy });
    await api('/api/v1/repos/balatro_3p_game/subscribe', { method: 'POST', token: newmember });
    await api('/api/v1/repos/weather_api/subscribe', { method: 'POST', token: newmember });
    await api('/api/v1/repos/bills/star', { method: 'POST', token: newmember });
    await api('/api/v1/repos/balatro_3p_game/star', { method: 'POST', token: newmember });
    await api('/api/v1/repos/bills/fork', { method: 'POST', token: newmember });

    t('member/subscriptions 返回 Andy 的订阅（balatro+bills）',
        (await api('/api/v1/member/subscriptions', { token: andy })).data.data.length === 2);
    t('member/stars 返回 Andy 的收藏（bills）',
        (await api('/api/v1/member/stars', { token: andy })).data.data.length === 1);
    t('fork 在库留一份（repos/NewMember/bills）+ 下载到工作区（home/NewMember/bills）',
        fs.existsSync(path.join(__dirname, 'repos', 'NewMember', 'bills'))
        && fs.existsSync(path.join(__dirname, 'home', 'NewMember', 'bills')));

    // ---- issue / remark ----
    await api('/api/v1/repos/bills/issue', { method: 'POST', token: andy, body: { content: '账单接口有 bug' } });
    await api('/api/v1/repos/balatro_3p_game/remark', { method: 'POST', token: andy, body: { content: '这个库设计得不错' } });
    t('issue 空内容 → 400', (await api('/api/v1/repos/bills/issue', { method: 'POST', token: andy, body: { content: '' } })).status === 400);
    t('issue 无此库 → 404', (await api('/api/v1/repos/nonexistent/issue', { method: 'POST', token: andy, body: { content: 'xx' } })).status === 404);
    t('get issues 返回 1 条', (await api('/api/v1/repos/bills/issues', { token: andy })).data.issues.length === 1);
    t('get remarks 返回 1 条', (await api('/api/v1/repos/balatro_3p_game/remarks', { token: andy })).data.remarks.length === 1);

    // ---- call（endpoint 订阅门）----
    t('call 无此库 → 404', (await api('/api/v1/repos/nonexistent/call', { token: andy })).status === 404);
    t('call content 库 → 404（就地 read/fork）', (await api('/api/v1/repos/balatro_3p_game/call', { token: andy })).status === 404);
    const callDenied = await api('/api/v1/repos/weather_api/call', { token: andy }); // Andy 未订阅 weather_api
    t('call endpoint 未订阅 → 403', callDenied.status === 403);
    const callOwner = await api('/api/v1/repos/weather_api/call', { token: wen }); // owner 免检
    t('call endpoint owner → 200 url', callOwner.status === 200 && callOwner.data.url === 'https://api.example.com/weather');
    const callSub = await api('/api/v1/repos/weather_api/call', { token: newmember }); // 已订阅
    t('call endpoint 订阅者 → 200 url', callSub.status === 200 && callSub.data.url === 'https://api.example.com/weather');

    // ---- 写面：subscribers / stars / update / archive ----
    const subsOwner = await api('/api/v1/repos/balatro_3p_game/contributor/subscribers', { token: hinton });
    t('contributor subscribers owner → 200 count>=2', subsOwner.status === 200 && subsOwner.data.count >= 2);
    t('contributor subscribers 非 owner → 403', (await api('/api/v1/repos/balatro_3p_game/contributor/subscribers', { token: andy })).status === 403);
    const starsOwner = await api('/api/v1/repos/balatro_3p_game/contributor/stars', { token: hinton });
    t('contributor stars owner → 200 count>=1', starsOwner.status === 200 && starsOwner.data.count >= 1);

    t('update version → 200', (await api('/api/v1/repos/bills/contributor/update', { method: 'POST', token: andy, body: { version: '2.0.0' } })).status === 200);
    t('bills version 已更新', (await api('/api/v1/repos/bills', { token: andy })).data.version === '2.0.0');
    t('update 非 owner → 403', (await api('/api/v1/repos/bills/contributor/update', { method: 'POST', token: hinton, body: { version: '9' } })).status === 403);
    t('update 空 body → 400', (await api('/api/v1/repos/bills/contributor/update', { method: 'POST', token: andy, body: {} })).status === 400);

    const arch = await api('/api/v1/repos/bills/contributor/archive', { method: 'POST', token: andy });
    t('archive → 200', arch.status === 200);
    const list = await api('/api/v1/repos', { token: andy });
    t('归档后公开列表不含 Andy 的 bills（NewMember 同名 fork 仍应在）',
        !list.data.some(r => r.name === 'bills' && r.author === 'Andy')
        && list.data.some(r => r.name === 'bills' && r.author === 'NewMember'));
    t('归档 repo 按名仍可查 archived=1', (await api('/api/v1/repos/bills', { token: andy })).data.archived === 1);

    // ---- upload ----
    const ws = path.join(__dirname, 'home', 'Andy', 'my-tool');
    fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'main.js'), 'console.log("hi")\n');
    fs.writeFileSync(path.join(ws, 'README.md'), '# my-tool\n');
    fs.writeFileSync(path.join(ws, 'data', 'secret.json'), '{"k":"v"}\n');
    fs.writeFileSync(path.join(ws, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n');
    fs.writeFileSync(path.join(ws, '.agtignore'), 'secret.json\nnode_modules/\n');
    fs.writeFileSync(path.join(ws, 'endpoint_url'), 'http://localhost:9999/tool\n');

    const upload = await api('/api/v1/member/upload?dir=my-tool', { method: 'POST', token: andy });
    t('upload → 201 type endpoint', upload.status === 201 && upload.data.type === 'endpoint');
    t('my-tool 入库 type=endpoint', (await api('/api/v1/repos/my-tool', { token: andy })).data.type === 'endpoint');
    const myToolCall = await api('/api/v1/repos/my-tool/call', { token: andy });
    t('my-tool call owner → 200 url', myToolCall.status === 200 && myToolCall.data.url === 'http://localhost:9999/tool');
    const mainRead = await api('/api/v1/repos/my-tool/read?file=main.js', { token: andy });
    t('read main.js → 200 含内容', mainRead.status === 200 && mainRead.data.content.includes('console.log'));
    const secretRead = await api('/api/v1/repos/my-tool/read?file=data/secret.json', { token: andy });
    t('.agtignore 排除的文件不可读 → 404（basename 规则）', secretRead.status === 404);
    const nmRead = await api('/api/v1/repos/my-tool/read?file=node_modules/dep/index.js', { token: andy });
    t('.agtignore 排除的目录不可读 → 404（目录规则整棵排除）', nmRead.status === 404);
    t('upload 绝对路径 → 403', (await api('/api/v1/member/upload?dir=' + encodeURIComponent('/etc'), { method: 'POST', token: andy })).status === 403);
    t('upload 相对路径逃出工作区 → 403', (await api('/api/v1/member/upload?dir=' + encodeURIComponent('../../'), { method: 'POST', token: andy })).status === 403);

    // ---- update 文件重传（?dir= 工作区相对路径）----
    fs.writeFileSync(path.join(ws, 'v2.js'), 'console.log("v2")\n');
    const upd2 = await api('/api/v1/repos/my-tool/contributor/update?dir=my-tool', { method: 'POST', token: andy });
    t('update 重传文件 → 200', upd2.status === 200);
    const v2Read = await api('/api/v1/repos/my-tool/read?file=v2.js', { token: andy });
    t('update 后新文件可读 → 200', v2Read.status === 200 && v2Read.data.content.includes('v2'));
    const mainRead2 = await api('/api/v1/repos/my-tool/read?file=main.js', { token: andy });
    t('update 后旧文件仍在（整目录替换）', mainRead2.status === 200);
    t('update 绝对路径 → 403', (await api('/api/v1/repos/my-tool/contributor/update?dir=' + encodeURIComponent('/etc'), { method: 'POST', token: andy })).status === 403);

    // ---- git 版本化 ----
    const commits1 = await api('/api/v1/repos/my-tool/commits', { token: andy });
    t('my-tool 上传后有 git 历史（初始 commit）', commits1.data.commits.length >= 1);
    // 工作区加 v3.js → update 重传 → 新 commit（历史继续，不重建）
    fs.writeFileSync(path.join(ws, 'v3.js'), 'console.log("v3")\n');
    const upd3 = await api('/api/v1/repos/my-tool/contributor/update?dir=my-tool', { method: 'POST', token: andy });
    t('update 重传 → 200', upd3.status === 200);
    const commits2 = await api('/api/v1/repos/my-tool/commits', { token: andy });
    t('update 后 commit 数 +1', commits2.data.commits.length === commits1.data.commits.length + 1);
    const diff = await api('/api/v1/repos/my-tool/commit/' + commits2.data.commits[0].sha, { token: andy });
    t('commit diff 可查且含 v3', diff.status === 200 && diff.data.diff.includes('v3'));
    // rollback 撤销该 update → v3.js 消失、main.js 仍在、历史只增不减
    const rb = await api('/api/v1/repos/my-tool/contributor/rollback', { method: 'POST', token: andy, body: { sha: commits2.data.commits[0].sha } });
    t('rollback → 200', rb.status === 200);
    t('rollback 后 v3.js 被撤销 → read 404', (await api('/api/v1/repos/my-tool/read?file=v3.js', { token: andy })).status === 404);
    t('rollback 后 main.js 仍在 → read 200', (await api('/api/v1/repos/my-tool/read?file=main.js', { token: andy })).status === 200);
    const commits3 = await api('/api/v1/repos/my-tool/commits', { token: andy });
    t('rollback 追加撤销提交（历史只增不减）', commits3.data.commits.length === commits2.data.commits.length + 1);
    t('rollback 非 owner → 403', (await api('/api/v1/repos/my-tool/contributor/rollback', { method: 'POST', token: newmember, body: { sha: commits2.data.commits[0].sha } })).status === 403);
    t('rollback 缺 sha → 400', (await api('/api/v1/repos/my-tool/contributor/rollback', { method: 'POST', token: andy, body: {} })).status === 400);

    // ---- admin ----
    t('admin 查订阅表 → 200', (await api('/api/v1/admin/subscriptions', { token: admin })).status === 200);
    t('member 查订阅表 → 403', (await api('/api/v1/admin/subscriptions', { token: andy })).status === 403);

    // ---- 清理测试残留（fork 目录 + 工作区 + upload 样例） ----
    store.remove('repos', 'name', 'my-tool');
    fs.rmSync(path.join(__dirname, 'repos', 'Andy', 'my-tool'), { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, 'repos', 'NewMember'), { recursive: true, force: true });
    fs.rmSync(path.join(__dirname, 'home'), { recursive: true, force: true });

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

if(require.main === module) {
    run().catch(err => { console.error(err); process.exit(1); });
}
