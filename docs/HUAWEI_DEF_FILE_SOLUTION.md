# Soluzione LLDP per Huawei in NeDi

**Data**: 2025-11-30
**Problema**: Switch Huawei falliscono discovery LLDP in NeDi
**Root Cause**: Nessun file `.def` per Huawei, cadono in `other.def` con `Dispro` vuoto

---

## Problema Identificato

### Esplorazione Server NeDi

```bash
# Directory esplorata
/var/nedi/sysobj/    # 1467 file .def

# Ricerca Huawei
find /var/nedi/sysobj -name "*2011*"   # NESSUN RISULTATO
find /var/nedi/sysobj -name "*huawei*" # NESSUN RISULTATO
```

### Root Cause

1. **Huawei OID**: `1.3.6.1.4.1.2011.x`
2. **Nessun file `.def`** per questo OID
3. **Fallback**: `other.def` con `Dispro` **VUOTO**
4. **Risultato**: NeDi non tenta LLDP, usa solo MAC/ARP

---

## Soluzione: File .def Ottimale per Huawei

### Step 1: Connessione SSH a NeDi

```bash
ssh $NEDI_SSH_USER@$NEDI_SSH_HOST
# Password: see .env
```

### Step 2: Creare il File .def

```bash
cat > /var/nedi/sysobj/1.3.6.1.4.1.2011.def << 'EOF'
# Definition for Huawei Enterprise Switches
# Created: 2025-11-30
# OID: 1.3.6.1.4.1.2011 (Huawei enterprise)
# Models: S5700, S6720, S7700, CE series, AR series
# Reference: https://support.huawei.com/enterprise/en/doc/EDOC1000178181

# === GENERAL SECTION ===
SNMPv       2HC
Type        Huawei Switch
OS          VRP
Icon        s3m
Size        1
Uptime      S
Dispro      LLDP

# === BRIDGE/MAC SECTION ===
Bridge      qbriV
ArpND       phy
Getfwd      dyn

# === INTERFACE SECTION ===
# Standard IF-MIB (RFC 2863)
IFname      1.3.6.1.2.1.31.1.1.1.1
IFaddr      1.3.6.1.2.1.4.20.1.2
IFalias     1.3.6.1.2.1.31.1.1.1.18
IFvlan      1.3.6.1.2.1.17.7.1.4.5.1.1
InBcast     1.3.6.1.2.1.31.1.1.1.3
OutBcast    1.3.6.1.2.1.31.1.1.1.5
InDisc      1.3.6.1.2.1.2.2.1.13
OutDisc     1.3.6.1.2.1.2.2.1.19
InErrors    1.3.6.1.2.1.2.2.1.14
OutErrors   1.3.6.1.2.1.2.2.1.20

# Duplex settings (standard values)
Halfdp      2
Fulldp      3

# === VLAN SECTION ===
VLnams      1.3.6.1.2.1.17.7.1.4.3.1.1
VLid        Q

# === ENTITY MIB (Modules) ===
# Standard ENTITY-MIB (RFC 4133)
Serial      1.3.6.1.2.1.47.1.1.1.1.11.1
Bimage      1.3.6.1.2.1.47.1.1.1.1.10.1
Modesc      1.3.6.1.2.1.47.1.1.1.1.2
Moclas      1.3.6.1.2.1.47.1.1.1.1.5
Modser      1.3.6.1.2.1.47.1.1.1.1.11
Modfw       1.3.6.1.2.1.47.1.1.1.1.9
Modsw       1.3.6.1.2.1.47.1.1.1.1.10
Modnam      1.3.6.1.2.1.47.1.1.1.1.7

# === HUAWEI-SPECIFIC MONITORING ===
# HUAWEI-ENTITY-EXTENT-MIB (hwEntityExtMIB)
# CPU Utilization
CPUutl      1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5

# Memory Utilization
MemCPU      1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7

# Temperature
Temp        1.3.6.1.4.1.2011.5.25.31.1.1.1.1.11

# Power Supply Status
# Supply      1.3.6.1.4.1.2011.5.25.31.1.1.10.1.7

Custom
EOF
```

### Step 3: Verifica Creazione

```bash
ls -la /var/nedi/sysobj/1.3.6.1.4.1.2011.def
grep "^Dispro" /var/nedi/sysobj/1.3.6.1.4.1.2011.def
# Output atteso: Dispro      LLDP
```

### Step 4: Riavvia Discovery (opzionale)

```bash
# Forza discovery manuale
/var/nedi/nedi.pl -d

# Oppure attendi prossimo cron job (ogni 2 ore)
```

---

## File .def Alternativo (Minimo)

Per testing rapido, versione minimale:

```bash
cat > /var/nedi/sysobj/1.3.6.1.4.1.2011.def << 'EOF'
# Minimal Huawei definition for LLDP
Type        Huawei
OS          VRP
Icon        s3m
Dispro      LLDP
SNMPv       2HC
IFname      1.3.6.1.2.1.31.1.1.1.1
Bridge      qbriV
Custom
EOF
```

---

## Opzione Alternativa: Modificare other.def

Se vuoi abilitare LLDP per TUTTI i device sconosciuti:

```bash
# Backup
cp /var/nedi/sysobj/other.def /var/nedi/sysobj/other.def.bak

# Modifica
sed -i 's/^Dispro$/Dispro      LLDP|CDP/' /var/nedi/sysobj/other.def
```

**Attenzione**: Questo affetta tutti i device generici, non solo Huawei.

---

## Verifica Post-Implementazione

### 1. Check Device Classification

```bash
mysql -u nedi -p$NEDI_MYSQL_PASS nedi -e "
SELECT name, sysobj, type
FROM devices
WHERE sysobj LIKE '1.3.6.1.4.1.2011%'
LIMIT 10;
"
```

### 2. Check LLDP Links

```bash
mysql -u nedi -p$NEDI_MYSQL_PASS nedi -e "
SELECT device, ifname, neighbor, nbrifname
FROM links
WHERE device IN (
  SELECT name FROM devices WHERE sysobj LIKE '1.3.6.1.4.1.2011%'
)
LIMIT 20;
"
```

### 3. Sync NetMap

```bash
# Da workstation
curl -X POST http://localhost:3001/api/admin/sync-nedi
```

---

## OID Reference Huawei

### Enterprise OID
- **Base**: `1.3.6.1.4.1.2011`
- **S5700**: `1.3.6.1.4.1.2011.2.23.x`
- **S6720**: `1.3.6.1.4.1.2011.2.239.x`
- **CE Series**: `1.3.6.1.4.1.2011.2.285.x`

### LLDP MIB (Standard IEEE 802.1AB)
```
lldpLocPortTable:    1.0.8802.1.1.2.1.3.7
lldpRemTable:        1.0.8802.1.1.2.1.4.1
lldpLocPortDesc:     1.0.8802.1.1.2.1.3.7.1.4
lldpRemSysName:      1.0.8802.1.1.2.1.4.1.1.9
lldpRemPortDesc:     1.0.8802.1.1.2.1.4.1.1.8
```

### Monitoring OIDs (HUAWEI-ENTITY-EXTENT-MIB)
```
hwEntityCpuUsage:    1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5
hwEntityMemUsage:    1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7
hwEntityTemperature: 1.3.6.1.4.1.2011.5.25.31.1.1.1.1.11
hwEntityVoltage:     1.3.6.1.4.1.2011.5.25.31.1.1.1.1.8
```

---

## Troubleshooting

### LLDP Non Funziona Dopo Modifica

1. **Verifica LLDP abilitato sugli switch Huawei**:
   ```
   <HUAWEI> display lldp neighbor
   <HUAWEI> display lldp local
   ```

2. **Verifica SNMP read community**:
   ```
   <HUAWEI> display snmp-agent community read
   ```

3. **Test SNMP da NeDi server**:
   ```bash
   snmpwalk -v 2c -c public <huawei-ip> 1.0.8802.1.1.2.1.4.1.1.9
   ```

### Device Ancora in other.def

Il file `.def` deve matchare l'inizio dell'OID:
- File: `1.3.6.1.4.1.2011.def`
- Match: `1.3.6.1.4.1.2011.*`

Se il device ha OID più specifico (es. `1.3.6.1.4.1.2011.2.23.100`), NeDi cerca in ordine:
1. `1.3.6.1.4.1.2011.2.23.100.def` (exact)
2. `1.3.6.1.4.1.2011.2.23.def`
3. `1.3.6.1.4.1.2011.2.def`
4. `1.3.6.1.4.1.2011.def` ← il nostro file
5. `other.def` (fallback)

---

## Sources

- [NeDi Documentation - Expand](https://www.nedi.ch/documentation/expand/)
- [Huawei LLDP-MIB Reference](https://support.huawei.com/enterprise/en/doc/EDOC1100065672/546de90a/lldp-mib)
- [Huawei SNMPv2-MIB Reference](https://support.huawei.com/enterprise/en/doc/EDOC1000178181/7c6ad5b4/snmpv2-mib)
- [i-Vertix NeDi Integration](https://i-vertix.guide/monitoring/monitoring-resources/discovery/nedi/)

---

## Metadata

**Created**: 2025-11-30
**Author**: Claude Code
**Context**: Soluzione problema LLDP fallisce su switch Huawei in NeDi
