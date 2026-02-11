import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Libreria per ping (stile NeDi - fping)
 * Prima fa ping per trovare host attivi, poi fa SNMP solo su quelli
 */
class NetMapPing {
  constructor() {
    this.isWindows = process.platform === 'win32';
  }

  /**
   * Ping singolo host
   */
  async ping(ip, timeout = 1000) {
    return new Promise((resolve) => {
      const command = this.isWindows
        ? `ping -n 1 -w ${timeout} ${ip}`
        : `ping -c 1 -W ${Math.floor(timeout / 1000)} ${ip}`;

      exec(command, { timeout: timeout + 500 }, (error) => {
        // Se error è null, ping ha avuto successo
        resolve(!error);
      });
    });
  }

  /**
   * Ping multipli in parallelo (stile fping)
   */
  async pingMultiple(ips, concurrency = 10, timeout = 1000) {
    const results = [];
    const queue = [...ips];
    const activeIPs = [];

    const workers = new Array(concurrency).fill(null).map(async () => {
      while (queue.length) {
        const ip = queue.shift();
        try {
          const isAlive = await this.ping(ip, timeout);
          if (isAlive) {
            activeIPs.push(ip);
          }
          results.push({ ip, alive: isAlive });
        } catch (err) {
          results.push({ ip, alive: false });
        }
      }
    });

    await Promise.all(workers);
    return { activeIPs, results };
  }

  /**
   * Ping CIDR (stile NeDi fping -g)
   * Restituisce solo gli IP attivi
   */
  async pingCIDR(cidr, timeout = 1000, concurrency = 20) {
    const Cidr = (await import('ip-cidr')).default;
    
    if (!Cidr.isValidCIDR(cidr)) {
      throw new Error('CIDR non valido');
    }

    const cidrObj = new Cidr(cidr);
    const allIPs = cidrObj.toArray();
    
    // Filtra network e broadcast
    const ipParts = cidr.split('/');
    const prefixLength = parseInt(ipParts[1]);
    let hosts = allIPs;
    
    if (prefixLength < 31) {
      // Escludi network (primo) e broadcast (ultimo)
      if (hosts.length > 2) {
        hosts = hosts.slice(1, -1);
      }
    }

    // Ping tutti gli host in parallelo
    const { activeIPs } = await this.pingMultiple(hosts, concurrency, timeout);
    
    return activeIPs;
  }
}

export default NetMapPing;









