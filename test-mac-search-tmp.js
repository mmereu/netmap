const mysql = require('mysql2/promise');

async function test() {
  const db = await mysql.createConnection({
    host: process.env.NEDI_MYSQL_HOST || 'localhost',
    user: process.env.NEDI_MYSQL_USER || 'nedi',
    password: process.env.NEDI_MYSQL_PASS || '',
    database: process.env.NEDI_MYSQL_DB || 'nedi'
  });

  const cleanMac = '00e60e745e80';

  const [positions] = await db.query(
    'SELECT n.device, n.ifname, n.vlanid, n.lastseen, ' +
    '(SELECT COUNT(DISTINCT mac) FROM nodes n2 WHERE n2.device = n.device AND n2.ifname = n.ifname) as macCount ' +
    'FROM nodes n WHERE n.mac = ? ' +
    'AND n.ifname NOT LIKE "Eth-Trunk%" ' +
    'AND n.ifname NOT LIKE "Port-channel%" ' +
    'AND n.ifname NOT LIKE "Trunk%" ' +
    'GROUP BY n.device, n.ifname ' +
    'ORDER BY macCount ASC, n.lastseen DESC LIMIT 5',
    [cleanMac]
  );

  console.log('Positions found:', positions.length);
  positions.forEach((p, i) => {
    console.log(i + ': device=' + p.device + ' ifname=' + p.ifname + ' macCount=' + p.macCount);
  });

  if (positions.length > 0) {
    const endpoint = positions[0];
    console.log('Selected endpoint macCount:', endpoint.macCount);
    console.log('macCount > 100 ?', endpoint.macCount > 100);

    if (endpoint.macCount > 100) {
      const [switchAPs] = await db.query(
        'SELECT neighbor, ifname, linkdesc FROM links WHERE device = ? AND neighbor LIKE "PDV%" ORDER BY neighbor',
        [endpoint.device]
      );
      console.log('APs found:', switchAPs.length);
      switchAPs.forEach(ap => console.log('  - ' + ap.neighbor + ' on ' + ap.ifname));
    }
  }

  await db.end();
}

test().catch(console.error);
