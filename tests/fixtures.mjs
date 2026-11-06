/**
 * Node 测试夹具：从游戏真实资源包构造与 window.__SGBY_CORE__ 同构的 core。
 *
 * 所有被断言的数据均来自 original/site/assets/game.zip：
 *   struct/城市数据.json、武将数据.json、武将队列.json、城市连接右.json、
 *   界面常量.json、战斗地图1.json、strings.json、manifest.json
 * 仅结构性字段（回合数、战斗缓存等）用 0/空数组初始化以保持 Dn 形状，
 * 这些字段不参与任何「业务数值」断言。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openZip } from './zip-lite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ZIP_PATH = path.resolve(HERE, '..', 'original', 'site', 'assets', 'game.zip');

const STR_RES = {
  1: '界面字符串',
  11: '技能名', 12: '技能说明',
  58: '城市名',
  62: '武将名1', 70: '武将名2', 71: '武将名3', 72: '武将名4',
  64: '字符串常量',
  73: '道具名', 74: '道具说明',
};
const DIR_KEYS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

const flatten = (v) => {
  if (Array.isArray(v)) return v.flatMap(flatten);
  return [Number(v) & 0xff];
};

export function loadRealData() {
  const zip = openZip(ZIP_PATH);
  const data = {
    manifest: zip.readJson('manifest.json'),
    strings: zip.readJson('strings.json'),
    constants: zip.readJson('struct/界面常量.json'),
    cityData: zip.readJson('struct/城市数据.json'),
    personData: zip.readJson('struct/武将数据.json'),
    personQueue: zip.readJson('struct/武将队列.json'),
    connRight: zip.readJson('struct/城市连接右.json'),
    connLeft: zip.readJson('struct/城市连接左.json'),
    battleMap1: zip.readJson('struct/战斗地图1.json'),
    zip,
  };
  return data;
}

/** 与 class se (sgby.min.js L2028) 的读取接口同构，数据全部来自真实资源包。 */
export class RealLib {
  constructor(data) {
    this.data = data;
    this._nameToId = new Map();
    for (const [id, v] of Object.entries(data.manifest.resources)) this._nameToId.set(v.name, Number(id));
    this._constKeys = Object.keys(data.constants).filter((k) => k !== '说明');
    this._cache = new Map();
  }

  resId(name) { return this._nameToId.get(name) ?? 0; }

  getStr(id, idx) {
    const name = STR_RES[id];
    if (!name) return '';
    const arr = this.data.strings[name];
    if (!arr || idx < 1 || idx > arr.length) return '';
    return arr[idx - 1] ?? '';
  }

  getConst(idx) { return this.getStr(64, idx); }   // P0: getConst(n) = getStr(64,n)

  getItem(id, idx) {
    const key = `${id}:${idx}`;
    if (this._cache.has(key)) return this._cache.get(key);
    let out = null;
    if (id === 2) {
      const name = this._constKeys[idx - 1];
      if (name) out = Uint8Array.from(flatten(this.data.constants[name]));
    } else if (id === 59 || id === 60) {
      const table = id === 59 ? this.data.connRight : this.data.connLeft;
      const bytes = [];
      for (const c of table['城市']) {
        for (const d of DIR_KEYS) bytes.push(c['连接'][d] & 0xff);
        for (const d of DIR_KEYS) bytes.push(c['距离'][d] & 0xff);
      }
      out = Uint8Array.from(bytes);
    }
    this._cache.set(key, out);
    return out;
  }

  itemCount(id) {
    if (id === 57) return this.data.cityData['时期'].length;
    return 0;
  }
}

/** 构造与 Dn (sgby.min.js L2415) 同形的真实数据状态。 */
export function makeRealCore(data = loadRealData()) {
  const lib = new RealLib(data);
  const period = data.cityData['时期'][0];
  const persons = data.personData['时期'][0];
  const queue = data.personQueue['时期'][0];
  const mapHead = data.battleMap1['头部'];

  const g_Cities = period['城市'].map((c) => ({
    Id: 0,
    Belong: c['归属'], SatrapId: c['太守'],
    FarmingLimit: c['农业上限'], Farming: c['农业'],
    CommerceLimit: c['商业上限'], Commerce: c['商业'],
    PeopleDevotion: c['民忠'], AvoidCalamity: c['防灾'],
    PopulationLimit: c['人口上限'], Population: c['人口'],
    Money: c['金钱'], Food: c['粮食'], MothballArms: c['后备兵力'],
    PersonQueue: c['人才队列'], Persons: c['人才数'],
    ToolQueue: c['道具队列'], Tools: c['道具数'],
  }));

  const g_Persons = persons.map((p) => ({
    Id: 0, Belong: p['归属'], Level: p['等级'], Force: p['武力'], IQ: p['智力'],
    Devotion: p['忠诚'], Character: p['性格'], Experience: p['经验'], Thew: p['体力'],
    ArmsType: p['兵种'], Arms: p['兵力'], Equip: [...p['装备']], Age: p['年龄'],
  }));

  const g_PersonsQueue = new Uint16Array(200);
  for (let i = 0; i < Math.min(200, queue.length); i++) g_PersonsQueue[i] = queue[i];

  const Dn = {
    lib,
    g_PlayerKing: 0,
    g_YearDate: period['年份'], g_MonthDate: 1, g_PIdx: 0,
    g_LookEnemy: 1, g_LookMovie: 1, g_MoveSpeed: 1, g_Diff: 0, diffs: [],
    g_Persons, g_Cities, g_PersonsQueue,
    g_GoodsQueue: new Uint16Array(33),
    g_OrderQueue: Array.from({ length: 100 }, () => ({ OrderId: 255 })),
    g_FightersIdx: new Uint8Array(30),
    g_Fighters: new Uint16Array(300),
    g_CityPos: { x: 0, y: 0, setx: 0, sety: 0 },
    g_FgtAtkRng: new Uint8Array(86),
    g_FightPath: new Uint8Array(250).fill(255),
    g_FightMap: new Uint8Array(285),
    g_FgtParam: {
      Mode: 0, MProvender: 0, EProvender: 0,
      MapId: 110, Way: 0, GenArray: new Uint16Array(20),
    },
    g_FgtOver: 0, g_FgtBoutCnt: 0, g_FgtWeather: 1,
    g_GenPos: Array.from({ length: 20 }, () => ({ x: 0, y: 0, hp: 0, mp: 0, move: 0, active: 0, state: 0 })),
    g_GenAtt: [{}, {}],
    g_MapSX: 0, g_MapSY: 0, g_MapWid: mapHead[0], g_MapHgt: mapHead[2],
    g_FoucsX: 0, g_FoucsY: 0, g_CityX: 0, g_CityY: 0, g_MainGenIdx: 0,
    g_PathSX: 0, g_PathSY: 0, g_PUseSX: 0, g_PUseSY: 0,
    g_BakUpX: 0, g_BakUpY: 0, g_TileId: 54, cavpdb: 0, cavps: 0,
  };

  return Object.freeze({
    version: 'node-test-real-data',
    source: 'game.zip',
    Dn, l: null, lib,
    classes: Object.freeze({}),
    fns: Object.freeze({}),
  });
}
