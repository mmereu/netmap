# Huawei OID Reference (SNMP)

- Base vendor OID: `1.3.6.1.4.1.2011`
- DataCom branch: `1.3.6.1.4.1.2011.5.25` ([oidref.com](http://oidref.com/1.3.6.1.4.1.2011.5.25))
- LLDP Huawei extension root: `1.3.6.1.4.1.2011.5.25.134` ([Huawei Support](https://support.huawei.com/enterprise/en/doc/EDOC1000060766/d93e2d38/lldp-mib-object-names-and-oids))

## Identificazione dispositivo
- `1.3.6.1.2.1.1.1.0` sysDescr (standard)
- `1.3.6.1.2.1.1.2.0` sysObjectID (standard; Huawei inizia con `1.3.6.1.4.1.2011`)
- `1.3.6.1.2.1.1.5.0` sysName (standard)
- `1.3.6.1.2.1.1.6.0` sysLocation (standard)

## LLDP
- Standard LLDP RemTable base: `1.0.8802.1.1.2.1.4.1.1`
- Standard LLDP RemManAddrTable: `1.0.8802.1.1.2.1.4.2.1`
- Huawei LLDP extension (root): `1.3.6.1.4.1.2011.5.25.134`
  - Include TLV estesi (802.1/802.3) e gestione MDN (Media Dependent Neighbor)

## Interfacce
- IF‑MIB ifTable: `1.3.6.1.2.1.2.2.1`
- IF‑X‑MIB ifXTable: `1.3.6.1.2.1.31.1.1.1`
- Q‑BRIDGE‑MIB (VLAN):
  - `1.3.6.1.2.1.17.7.1.4.3.1.1` dot1qVlanStaticName
  - `1.3.6.1.2.1.17.7.1.4.5.1.1` dot1qPvid
  - `1.3.6.1.2.1.17.7.1.4.2.1.4` dot1qVlanCurrentEgressPorts

## L2/FDB
- BRIDGE‑MIB FDB: `1.3.6.1.2.1.17.4.3.1` (dot1dTpFdbTable)
- STP (BRIDGE‑MIB): `1.3.6.1.2.1.17.2` (scalari) e `1.3.6.1.2.1.17.2.15.1` (portTable)

## Indirizzi IP
- IPv4 (IP‑MIB): `1.3.6.1.2.1.4.20.1` (ipAddrTable)
- IPv4/IPv6 (IP‑MIB ipAddressTable): `1.3.6.1.2.1.4.34.1`
- IPv6 (IPV6‑MIB): `1.3.6.1.2.1.55.1.8.1`

## LACP
- IEEE8023‑LAG‑MIB: `1.2.840.10006.300.43.1.1` (aggregatori e membership)

## PoE
- POWER‑ETHERNET‑MIB: `1.3.6.1.2.1.105` (stato PSE e porte)

## Cisco/Extreme/Foundry discovery (per ambienti misti)
- CDP: `1.3.6.1.4.1.9.9.23.1.2.1.1`
- EDP: `1.3.6.1.4.1.1916.1.7.1.1.1`
- FDP: `1.3.6.1.4.1.1991.1.1.1.1.1.1`

## Note Huawei specifiche
- Enterprise root: `1.3.6.1.4.1.2011` contiene molte MIB proprietarie (es. `huaweiDatacomm` sotto `...5.25`) ([oidref.com](http://oidref.com/1.3.6.1.4.1.2011.5.25), [MIB Browser](https://mibbrowser.online/mibdb_search.php?search=1.3.6.1.4.1.2011.&vendor=Huawei)).
- LLDP esteso Huawei: `1.3.6.1.4.1.2011.5.25.134` fornisce TLV estesi e funzioni avanzate (MDN, trap) ([Huawei Support](https://support.huawei.com/enterprise/en/doc/EDOC1000060766/d93e2d38/lldp-mib-object-names-and-oids)).
- Oltre alle MIB standard, molte metriche Huawei su VLAN/port/stack/CPU/temperature sono sotto rami `2011.5.25.*` e variano per famiglia CloudEngine/Quidway.

## Strategia di utilizzo
- Preferire MIB standard per massima compatibilità; usare estensioni Huawei quando servono dettagli o performance migliori.
- Per LLDP su Huawei, gestire `timeMark` in OID albero remoto (già previsto dai parser del progetto).
- Validare sempre OID su device reale con `walk` e gestire fallback a MIB standard quando l’estensione non è disponibile.

## Riferimenti
- Huawei LLDP OIDs: CloudEngine LLDP MIB ([Huawei Support](https://support.huawei.com/enterprise/en/doc/EDOC1000060766/d93e2d38/lldp-mib-object-names-and-oids))
- Huawei enterprise branch: `2011.5.25` ([oidref.com](http://oidref.com/1.3.6.1.4.1.2011.5.25))
- Browser MIB Huawei: elenco OID ([mibbrowser.online](https://mibbrowser.online/mibdb_search.php?search=1.3.6.1.4.1.2011.&vendor=Huawei))
