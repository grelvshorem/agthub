const fs = require('fs');
const path = require('path');
const store = require('./store')

function reset() {
    try {
        store.clearAll();
        // endpoint 样例 repo：目录 + endpoint_url 文件（声明 URL），type=endpoint（存储按作者分目录）
        const weatherDir = path.join(__dirname, 'repos', 'Wen', 'weather_api');
        if(!fs.existsSync(weatherDir)) {
            fs.mkdirSync(weatherDir, { recursive: true });
            fs.writeFileSync(path.join(weatherDir, 'endpoint_url'),
                'https://api.example.com/weather\n');
        }
        store.insert('repos', {name: 'balatro_3p_game', author: 'Hinton', version: '1.0.1'}); // type 默认 content
        store.insert('repos', {name: 'bills', author: 'Andy', tags: 'API balance', version: '1.1.0'});
        store.insert('repos', {name: 'weather_api', author: 'Wen', type: 'endpoint', version: '1.0.0'});
        store.insert('users', {name: 'Hinton', alias: 'Researcher', role: 'member', password: '123'});
        store.insert('users', {name: 'Andy', alias: 'Planner', role: 'member', password: '1234'});
        store.insert('users', {name: 'Wen', role: 'member', password: '12345' });
        store.insert('users', {name: 'Shorem', role: 'admin', password: '123456'});
        console.table(store.listAll('repos'));
        console.table(store.listAll('users'));
    
    } catch(err) {
        console.error(err.message);
    }
}

module.exports = { reset };

if (require.main === module) {
    reset();
}