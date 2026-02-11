import snmp from 'net-snmp';
import Cidr from 'ip-cidr';

const COMMUNITY = process.env.SNMP_COMMUNITY || 'public';
const CIDR = process.env.CIDR || '192.168.1.0/24';
const LIMIT = Number(process.env.LIMIT || 256);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const TIMEOUT = Number(process.env.TIMEOUT || 3000);

function expandCidr(cidrStr, limit = 256) {
  if (!Cidr.isValidCIDR(cidrStr)) throw new Error('CIDR non valido');
  const cidr = new Cidr(cidrStr);
  return cidr.toArray({ limit });
}

// Decode helper
function decodeValue(vb) {
  if (!vb) return '';
  if (Buffer.isBuffer(vb)) return vb.toString('hex');
  if (typeof vb === 'object' && vb instanceof Buffer) return vb.toString('hex');
  return vb.toString();
}

async function walk(ip, oid) {
  return new Promise((resolve) => {
    const session = snmp.createSession(ip, COMMUNITY, {
      timeout: TIMEOUT,
      retries: 1,
      version: snmp.Version2c,
    });
    const rows = [];
    session.subtree(
      oid,
      50,
      (vb) => {
        const list = Array.isArray(vb) ? vb : [vb];
        for (const v of list) {
          if (v?.oid) {
            rows.push({ oid: v.oid, type: v.type, value: v.value });
          }
        }
      },
      (err) => {
        session.close();
        resolve({ err: err ? err.toString() : null, rows });
      }
    );
  });
}

async function scanHost(ip) {
  const res = { ip, sysName: null, lldp: [] };
  // sysName
  await new Promise((resolve) => {
    const session = snmp.createSession(ip, COMMUNITY, {
      timeout: TIMEOUT,
      retries: 1,
      version: snmp.Version2c,
    });
    session.get(['1.3.6.1.2.1.1.5.0'], (err, vbs) => {
      if (!err && vbs?.[0]?.value) res.sysName = vbs[0].value.toString();
      session.close();
      resolve();
    });
  });

  // LLDP RemTable
  const rem = await walk(ip, '1.0.8802.1.1.2.1.4.1.1');
  if (rem.rows.length) {
    res.lldp = rem.rows.map((r) => ({
      oid: r.oid,
      value: decodeValue(r.value),
      type: r.type,
    }));
  }
  return res;
}

async function run() {
  const hosts = expandCidr(CIDR, LIMIT);
  const queue = [...hosts];
  const results = [];
  const workers = Array(CONCURRENCY)
    .fill(null)
    .map(async () => {
      while (queue.length) {
        const ip = queue.shift();
        try {
          const r = await scanHost(ip);
          if (r.lldp.length || r.sysName) results.push(r);
        } catch (e) {
          results.push({ ip, error: e.message });
        }
      }
    });
  await Promise.all(workers);
  console.log(JSON.stringify(results, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
