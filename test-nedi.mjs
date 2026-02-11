#!/usr/bin/env node
import { getNeDiDB } from './libnedi.js';

async function test() {
  try {
    const nedi = await getNeDiDB({
      sshHost: process.env.NEDI_SSH_HOST || 'localhost',
      sshUser: process.env.NEDI_SSH_USER || 'root',
      sshPassword: process.env.NEDI_SSH_PASS || '',
      mysqlUser: process.env.NEDI_MYSQL_USER || 'nedi',
      mysqlPassword: process.env.NEDI_MYSQL_PASS || ''
    });

    console.log('\n=== TEST DEVICE ===');
    const device = await nedi.getDevice('10_L2_Rack_CassaCentrale_4');
    console.log('Device:', JSON.stringify(device, null, 2));

    console.log('\n=== TEST INTERFACES ===');
    const interfaces = await nedi.getDeviceInterfaces('10_L2_Rack_CassaCentrale_4');
    console.log('Interfaces count:', interfaces.length);
    console.log('First 3 interfaces:', JSON.stringify(interfaces.slice(0, 3), null, 2));

    console.log('\n=== TEST CONNECTIONS ===');
    const connections = await nedi.getDeviceConnections('10_L2_Rack_CassaCentrale_4');
    console.log('Connections count:', connections.length);
    console.log('Connections:', JSON.stringify(connections, null, 2));

    console.log('\n=== TEST FULL STATUS ===');
    const fullStatus = await nedi.getDeviceFullStatus('10_L2_Rack_CassaCentrale_4');
    console.log('Full Status:', JSON.stringify(fullStatus, null, 2));

    await nedi.close();
  } catch (err) {
    console.error('ERROR:', err);
    process.exit(1);
  }
}

test();
