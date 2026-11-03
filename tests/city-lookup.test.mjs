import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import dayjs from 'dayjs';
import * as pako from 'pako';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';

// Execute the real TS/TSX modules with only platform, UI hooks and storage replaced.
async function loadModule(path, dependencies, globals = {}) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
        fileName: path,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    const exports = {};
    await runInNewContext(`(async () => { ${outputText}\n })()`, {
        exports, Uint8Array, AbortController, AbortSignal, setTimeout, clearTimeout,
        console: { log() {}, error() {} },
        require(name) {
            assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
            return dependencies[name];
        },
        ...globals,
    });
    return exports;
}

const position = { lat: 31.23, lng: 121.47, tzid: 'Asia/Shanghai' };
const locationResponse = { lat: position.lat, lon: position.lng, timezone: position.tzid };
const locale = JSON.parse(await readFile(new URL('../src/language/zh-CN.json', import.meta.url), 'utf8'));

async function setup(fetch, globals) {
    const sociti = await loadModule('../src/mod/sociti.ts', { '@tauri-apps/plugin-http': { fetch }, pako }, globals);
    const search = await loadModule('../src/mod/searchCiti.tsx', {
        './sociti': sociti, 'react/jsx-runtime': { jsx, jsxs, Fragment },
    });
    const states = [];
    let cursor = 0;
    const errors = [];
    const AppData = { language: 'zh_CN', rcrl: true, city: { name: 'Saved city', position }, rawTime: ['06:00', '18:00'] };
    const { default: Mainoption } = await loadModule('../src/mod/Mainoption.tsx', {
        './sociti': sociti, './searchCiti': search,
        'react/jsx-runtime': { jsx, jsxs, Fragment },
        react: {
            useEffect() {},
            useState(initial) {
                const index = cursor++;
                if (!(index in states)) states[index] = initial;
                return [states[index], value => { states[index] = value; }];
            },
        },
        ahooks: { useRequest: () => ({ run() {} }), useUpdateEffect() {} },
        antd: { ...Object.fromEntries(['Input', 'AutoComplete', 'Button', 'Flex', 'Segmented', 'Tooltip', 'Space'].map(name => [name, name])), TimePicker: { RangePicker: 'RangePicker' } },
        dayjs: { default: dayjs }, '@ant-design/icons': { EnvironmentOutlined: 'EnvironmentOutlined', LoadingOutlined: 'LoadingOutlined', QuestionOutlined: 'QuestionOutlined' },
        '@tauri-apps/api/core': { invoke: async () => false },
        '@tauri-apps/plugin-autostart': {}, '@tauri-apps/plugin-opener': {},
        './ThemeConfig': { isWin11: true }, './Deviation': { default: 'Deviation' },
        '../com/ThemeSelector': { default: 'ThemeSelector' },
        './DataSave': { default: () => ({ AppData, setData: update => Object.assign(AppData, update) }) },
    });
    function render() {
        cursor = 0;
        const result = Mainoption({ locale, messageApi: { error: text => { errors.push(text); return Promise.resolve(); } }, options: [], getCity: async () => {}, Language: null, themeDack: false });
        const [button, input] = result.mains.find(item => item.key === 'city').change.props.children;
        return { ...result, button: button.props, input: input.props };
    }
    return { render, errors, AppData, sociti, search };
}

test('issue #31: HTTP 403 releases the city button and input without erasing the saved city', async () => {
    const app = await setup(async () => new Response(null, { status: 403 }));
    const savedCity = app.AppData.city;
    const lookup = app.render().button.onClick();
    assert.equal(app.render().button.disabled, true);
    const failure = await lookup.catch(error => error);
    assert.equal(app.render().button.disabled, false, 'city button must recover after HTTP 403');
    assert.equal(app.render().input.disabled, false, 'manual city entry must recover');
    assert.equal(failure, undefined, 'event handler must handle the rejection');
    assert.equal(app.AppData.city, savedCity);
    assert.equal(app.errors.length, 1);
    assert.ok(app.errors[0], 'error notification must have translated text');
});

for (const [name, fetch] of [
    ['network rejection', async () => { throw new Error('offline'); }],
    ['malformed JSON', async () => new Response('{')],
    ['missing coordinates', async () => Response.json({ status: 'fail' })],
    ['invalid coordinates', async () => Response.json({ ...locationResponse, lat: 91 })],
    ['missing timezone', async () => Response.json({ lat: 0, lon: 0 })],
    ['null location response', async () => Response.json(null)],
]) {
    test(`${name}: report failure, preserve the saved city and release controls`, async () => {
        const app = await setup(fetch);
        const savedCity = app.AppData.city;
        const failure = await app.render().button.onClick().catch(error => error);
        assert.equal(app.render().button.disabled, false);
        assert.equal(app.render().input.disabled, false);
        assert.equal(failure, undefined);
        assert.equal(app.AppData.city, savedCity);
        assert.equal(app.errors.length, 1);
        assert.ok(app.errors[0]);
    });
}

test('successful lookup accepts zero coordinates and saves the city', async () => {
    const app = await setup(async () => Response.json({ lat: 0, lon: 0, timezone: 'UTC', regionName: 'Region', city: 'City' }));
    await app.render().button.onClick();
    assert.equal(app.AppData.city.name, 'Region - City');
    assert.equal(app.AppData.city.position.lng, 0);
    assert.equal(app.AppData.city.position.lat, 0);
    assert.equal(app.render().input.value, 'Region - City');
    assert.equal(app.render().button.disabled, false);
    assert.equal(app.errors.length, 0);
});

for (const phase of ['connection', 'body']) {
    test(`stalled ${phase}: timeout aborts the request and releases controls`, { timeout: 2000 }, async () => {
        let expire, signal, cleared = false;
        let started;
        const ready = new Promise(resolve => { started = resolve; });
        const app = await setup(async (_url, init) => {
            signal = init.signal;
            if (phase === 'connection') {
                started();
                return new Promise(() => {});
            }
            return { ok: true, headers: new Headers(), json: () => { started(); return new Promise(() => {}); } };
        }, {
            setTimeout(callback, ms) { assert.equal(ms, 15000); expire = callback; return 1; },
            clearTimeout() { cleared = true; },
        });
        const lookup = app.render().button.onClick();
        await ready;
        assert.equal(typeof expire, 'function', 'HTTP requests must have a deadline');
        expire();
        await lookup;
        assert.equal(signal.aborted, true);
        assert.equal(cleared, true);
        assert.equal(app.render().button.disabled, false);
        assert.equal(app.errors.length, 1);
        assert.ok(app.errors[0]);
    });
}

test('no language skips lookup and releases the controls', async () => {
    const app = await setup(() => assert.fail('no request expected'));
    app.AppData.language = undefined;
    await app.render().CitiInit();
    assert.equal(app.render().button.disabled, false);
    assert.equal(app.errors.length, 0);
});

test('enabling sunrise mode without a city releases both loading states after failure', async () => {
    const app = await setup(async () => new Response(null, { status: 403 }));
    app.AppData.city = { name: '' };
    await app.render().openRc();
    assert.equal(app.render().mains.find(item => item.key === 'rcrl').loading, false);
    assert.equal(app.render().button.disabled, false);
    assert.equal(app.errors.length, 1);
});

test('getLocation rejects invalid responses and accepts numeric zero coordinates', async () => {
    for (const data of [false, null, {}, { lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: '0', lon: '0' }]) {
        const app = await setup(async () => Response.json(data));
        assert.equal(await app.sociti.getLocation(), undefined);
    }
    const app = await setup(async () => Response.json({ lat: 0, lon: 0, timezone: 'UTC' }));
    assert.equal((await app.sociti.getLocation()).lng, 0);
});

test('HTTP helper preserves JSON, HTML, gzip and non-2xx response handling', async () => {
    for (const [response, expected] of [
        [Response.json({ ok: true }), { ok: true }],
        [new Response('<html>test</html>', { headers: { 'Content-Type': 'text/html' } }), '<html>test</html>'],
        [new Response(pako.gzip('{"ok":true}'), { headers: { 'Content-Encoding': 'gzip' } }), { ok: true }],
        [new Response(null, { status: 403 }), false],
    ]) {
        let cleared = false;
        const app = await setup(async () => response, { setTimeout: () => 1, clearTimeout: () => { cleared = true; } });
        assert.equal(JSON.stringify(await app.sociti.GetHttp('https://example.test')), JSON.stringify(expected));
        assert.equal(cleared, true);
    }
});

test('every supported language includes the city lookup error', async () => {
    for (const file of ['zh-CN', 'zh-HK', 'en', 'es-ES', 'ja-JP', 'ru']) {
        const translation = JSON.parse(await readFile(new URL(`../src/language/${file}.json`, import.meta.url), 'utf8'));
        assert.ok(translation.main.TabsOptionBError, file);
    }
});

test('automatic location works without a second city lookup when QWeather is unavailable', async () => {
    const requests = [];
    const app = await setup(async url => {
        requests.push(new URL(url).hostname);
        return url.includes('ip-api.com')
            ? Response.json({ ...locationResponse, regionName: 'Shanghai', city: 'Shanghai' })
            : new Response(null, { status: 403 });
    });
    await app.render().button.onClick();
    assert.equal(app.errors.length, 0, 'valid IP location must not depend on QWeather authorization');
    assert.equal(app.AppData.city.name, 'Shanghai');
    assert.equal(app.AppData.city.position.lat, position.lat);
    assert.deepEqual(requests, ['demo.ip-api.com']);
});

test('saved city refresh does not require reverse geocoding', async () => {
    const app = await setup(() => assert.fail('saved coordinates must not trigger another city lookup'));
    await app.render().CitiInit(position);
    assert.equal(app.errors.length, 0);
    assert.equal(app.AppData.city.name, 'Saved city');
    assert.equal(app.render().button.disabled, false);
});

test('valid coordinates without a city name remain usable for sunrise calculation', async () => {
    const app = await setup(async () => Response.json(locationResponse));
    await app.render().button.onClick();
    assert.equal(app.errors.length, 0);
    assert.equal(app.AppData.city.name, `${position.lat}, ${position.lng}`);
    assert.equal(app.AppData.city.position.tzid, position.tzid);
});

test('live automatic location succeeds using only the existing IP endpoint', {
    skip: process.env.LIVE_LOCATION_TEST !== '1', timeout: 25000,
}, async () => {
    const requests = [];
    const app = await setup((url, init) => {
        const host = new URL(url).hostname;
        requests.push(host);
        assert.equal(host, 'demo.ip-api.com', 'automatic location must not need a second provider');
        return fetch(url, init);
    });
    await app.render().button.onClick();
    assert.equal(app.errors.length, 0, 'live automatic location failed');
    assert.ok(Number.isFinite(app.AppData.city.position.lat));
    assert.ok(Number.isFinite(app.AppData.city.position.lng));
    assert.ok(app.AppData.city.name);
    assert.deepEqual(requests, ['demo.ip-api.com']);
});
