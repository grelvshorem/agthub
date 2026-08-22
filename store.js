const Database = require('better-sqlite3');
const db = new Database('lib.db');

const TABLE_SCHEMAS = {
    repos: {
        fields: {
            id:         { type: 'INTEGER', primaryKey: true },
            name:       { type: 'TEXT', notNull: true },
            author:     { type: 'TEXT', notNull: true },
            tags:       { type: 'TEXT' },
            version:    { type: 'TEXT' },
            type:       { type: 'TEXT', notNull: true,
                check: "type IN ('content', 'endpoint')",
                default: 'content'
            },
            archived:   { type: 'INTEGER', notNull: true,
                check: "archived IN (0, 1)",
                default: 0
            }
        },
        tableConstraints: [
            `UNIQUE(name, author)`
        ]
    },
    subscriptions: {
        fields: {
            id:         { type: 'INTEGER', primaryKey: true },
            repo_name:  { type: 'TEXT', notNull: true },
            user_name:       { type: 'TEXT', notNull: true },
        },
        tableConstraints: [
            `UNIQUE(repo_name, user_name) ON CONFLICT IGNORE`
        ]
    },
    stars: {
        fields: {
            id:         { type: 'INTEGER', primaryKey: true },
            repo_name:  { type: 'TEXT', notNull: true },
            user_name:       { type: 'TEXT', notNull: true }
        },
        tableConstraints: [
            `UNIQUE(repo_name, user_name) ON CONFLICT IGNORE`
        ]
    },
    users: {
        fields: {
            id:         { type: 'INTEGER', primaryKey: true },
            name:       { type: 'TEXT', notNull: true, unique: true },
            alias:      { type: 'TEXT' },
            role:       { type: 'TEXT', notNull: true,
                check: "role IN ('admin', 'member')"
            },
            password:   { type: 'TEXT', notNull: true }
        },
    },
    issues: {
        fields: {
            id:         { type: 'INTEGER', primaryKey: true },
            repo_name:  { type: 'TEXT', notNull: true },
            user_name:  { type: 'TEXT', notNull: true },
            content:    { type: 'TEXT', notNull: true },
            created_at: { type: 'TEXT', notNull: true }
        }
    },
    remarks: {
        fields: {
            id:         { type: 'INTEGER', primaryKey: true },
            repo_name:  { type: 'TEXT', notNull: true },
            user_name:  { type: 'TEXT', notNull: true },
            content:    { type: 'TEXT', notNull: true },
            created_at: { type: 'TEXT', notNull: true }
        }
    }
};

function _genCreateTableSQL(tableName, schema) {
    const { fields, tableConstraints = [] } = schema;
    const fieldDefs = [];

    for(const [colName, colOpts] of Object.entries(fields)) {
        let def = `"${colName}" ${colOpts.type}`;
        if(colOpts.primaryKey) def += ' PRIMARY KEY';
        if(colOpts.notNull) def += ' NOT NULL';
        if(colOpts.unique) def += ' UNIQUE';
        if(colOpts.check) def += ` CHECK(${colOpts.check})`;
        if(colOpts.default !== undefined) {
            const d = colOpts.default;
            def += ` DEFAULT ${typeof d === 'number' ? d : `'${d}'`}`;
        }
        fieldDefs.push(def);
    }

    const allDefs = [...fieldDefs, ...tableConstraints];
    const sql = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n
        ${allDefs.join(',\n ')}\n
    )`;

    return sql + ';';
}

const allSQL = Object.entries(TABLE_SCHEMAS)
    .map(([tableName, schema]) => _genCreateTableSQL(tableName, schema)).join('\n\n');
// 加载时自动建表（CREATE TABLE IF NOT EXISTS）：已有表不重造、不动数据
db.exec(allSQL);

// 存量库迁移：老库的 repos 表没有 type/archived 列，CREATE TABLE IF NOT EXISTS 不会补列 → 手动 ALTER
function _migrate() {
    const cols = db.prepare('PRAGMA table_info("repos")').all().map(c => c.name);
    if(!cols.includes('type')) {
        db.exec(`ALTER TABLE "repos" ADD COLUMN type TEXT NOT NULL DEFAULT 'content'`);
    }
    if(!cols.includes('archived')) {
        db.exec(`ALTER TABLE "repos" ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    }
}
_migrate();

function _checkTable(tableName) {
    if (!TABLE_SCHEMAS.hasOwnProperty(tableName)) {
        throw new Error(`Invalid table name: ${tableName}`);
    }
}

// 用 SQLite 的 PRAGMA table_info 查表里是否有该列（动态拼 SQL 前校验，防错列名）
function _columnExists(tableName, fieldName) {
    const stmt = db.prepare(`PRAGMA table_info("${tableName}")`);
    const columns = stmt.all();
    return columns.some(col => col.name === fieldName);
}

function _genInsertTableSQL(tableName, fieldNames) {
    const columns = fieldNames.map(f => `"${f}"`).join(', ');
    const placeholders = fieldNames.map(() => '?').join(', ');
    return `INSERT INTO "${tableName}" (${columns}) VALUES (${placeholders})`;
}

function _genFindTableSQLHead(tableName) {
    return `SELECT * FROM "${tableName}" WHERE 1=1`;
}

function _genRemoveTableSQLHead(tableName) {
    return `DELETE FROM "${tableName}" WHERE 1=1`;
}

function _appendSQLCondition(sql, field) {
    let result = sql + ` AND "${field}" = ?`
    return result;
}

module.exports = { TABLE_SCHEMAS,
    insert, remove, multiRemove, listAll, find, multiFind, update, clear, clearAll };

/**
 * 插入一行。注意：values 的键会直接当 SQL 列名用——写表里真实的蛇形列名（repo_name），不是驼峰变量名
 * @param {string} tableName
 * @param {object} values - 列名→值 的映射
 * @returns {object} run() 结果：{ changes, lastInsertRowid }
 */
function insert(tableName, values) {
    _checkTable(tableName);
    const fieldNames = Object.keys(values);
    if(fieldNames.length === 0) throw new Error('No fields to insert');
    const sql = _genInsertTableSQL(tableName, fieldNames);
    const stmt = db.prepare(sql);
    const params = fieldNames.map(key => values[key]);
    const info = stmt.run(...params);
    return info;
}

/**
 * 按单列精确删除
 * @returns {object} run() 结果，.changes 是被删行数（0 = 没删到）
 */
function remove(tableName, field, value) {
    _checkTable(tableName);
    if(!_columnExists(tableName, field)) {
        throw new Error(`Column "${field}" does not exist in table "${tableName}"`);
    }
    const deleteSQL = `DELETE FROM "${tableName}" WHERE "${field}" = ?`;
    return db.prepare(deleteSQL).run(value);
}

/**
 * 多条件删除：WHERE field1=? AND field2=?...（fields[i] 与 values[i] 一一对应）
 * @returns {object} run() 结果，.changes === 0 表示没有可删的行（路由据此判 404）
 */
function multiRemove(tableName, fields, values) {
    _checkTable(tableName);
    if(fields.length === 0) {
        throw new Error('The length of fields cannot be 0, use clear()');
    }
    if (fields.length !== values.length) {
        throw new Error('Fields and values length mismatch');
    }
    let sql = _genRemoveTableSQLHead(tableName);
    fields.forEach(field => {
        if(!_columnExists(tableName, field)) {
            throw new Error(`Column "${field}" does not exist in table "${tableName}"`);
        }
        sql = _appendSQLCondition(sql, field)
    });
    const stmt = db.prepare(sql);
    return stmt.run(...values);
}

/**
 * 按单列精确查一行
 * @returns {object|undefined} 命中返回行对象，未命中返回 undefined
 */
function find(tableName, field, value) {
    _checkTable(tableName);
    if(!_columnExists(tableName, field)) {
        throw new Error(`Column "${field}" does not exist in table "${tableName}"`);
    }
    const selectSQL = `SELECT * FROM "${tableName}" WHERE "${field}" = ?`;
    const row = db.prepare(selectSQL).get(value);
    return row;
}

/**
 * 多条件查询：WHERE field1=? AND field2=?...（fields 为空 = 查全表）
 * @param {string} tableName
 * @param {array} fields
 * @param {array} values
 * @returns {array} 命中行数组（可能为空）
 */
function multiFind(tableName, fields, values) {
    _checkTable(tableName);
    if (fields.length !== values.length) {
        throw new Error('Fields and values length mismatch');
    }
    let sql = _genFindTableSQLHead(tableName);
    fields.forEach(field => {
        if(!_columnExists(tableName, field)) {
            throw new Error(`Column "${field}" does not exist in table "${tableName}"`);
        }
        sql = _appendSQLCondition(sql, field)
    });
    const row = db.prepare(sql).all(...values);
    return row
}

/**
 * 更新一行或多行：SET values 的列，WHERE condFields=condValues（AND 连接）
 * @param {object} values - 要改的 列名→新值
 * @param {array} condFields - 定位条件列
 * @param {array} condValues - 定位条件值（与 condFields 一一对应）
 * @returns {object} run() 结果，.changes === 0 表示没匹配到行
 */
function update(tableName, values, condFields, condValues) {
    _checkTable(tableName);
    const setFields = Object.keys(values);
    if(setFields.length === 0) throw new Error('No fields to update');
    if(condFields.length !== condValues.length) {
        throw new Error('Fields and values length mismatch');
    }
    [...setFields, ...condFields].forEach(field => {
        if(!_columnExists(tableName, field)) {
            throw new Error(`Column "${field}" does not exist in table "${tableName}"`);
        }
    });
    const setSQL = setFields.map(f => `"${f}" = ?`).join(', ');
    const condSQL = condFields.map(f => `"${f}" = ?`).join(' AND ');
    const sql = `UPDATE "${tableName}" SET ${setSQL} WHERE ${condSQL}`;
    return db.prepare(sql).run(...setFields.map(f => values[f]), ...condValues);
}

/** 列出表里全部行 */
function listAll(tableName) {
    _checkTable(tableName);
    const selectSQL = `SELECT * FROM "${tableName}"`;
    const rows = db.prepare(selectSQL).all();
    return rows;
}

/** 清空一张表（保留表结构） */
function clear(tableName) {
    _checkTable(tableName);
    db.prepare(`DELETE FROM "${tableName}"`).run();
}

/** 清空所有表（seed.reset 用） */
function clearAll() {
    Object.keys(TABLE_SCHEMAS).forEach(table => clear(table));
}