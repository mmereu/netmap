# LLDP SNMP: Perché usare WALK invece di GET

## Problema

Quando si testa la presenza di LLDP via SNMP, l'approccio ingenuo di usare `session.get()` su un OID LLDP può dare **falsi positivi** o **falsi negativi**.

### Esempio OID problematico
```javascript
// ❌ METODO ERRATO
const LLDP_OID = '1.0.8802.1.1.2.1.1.1.0'; // lldpMessageTxInterval
session.get([LLDP_OID], callback);
```

**Problema**: Questo OID può esistere anche se:
- LLDP è disabilitato globalmente
- LLDP è abilitato ma non ci sono neighbor
- Il device supporta LLDP in teoria ma non lo usa in pratica

## Soluzione: SNMP WALK sulle tabelle Remote

### OID corretti (tabelle con indici dinamici)
```javascript
// ✅ METODO CORRETTO
const LLDP_REMOTE_SYSNAME = '1.0.8802.1.1.2.1.4.1.1.9'; // lldpRemSysName
const LLDP_REMOTE_PORTID = '1.0.8802.1.1.2.1.4.1.1.7';  // lldpRemPortId
```

### Perché questi OID hanno indici dinamici?

Le tabelle LLDP Remote hanno questa struttura:
```
1.0.8802.1.1.2.1.4.1.1.9.<timeMark>.<localPortNum>.<index>
                        └──────────────┬──────────────┘
                                  Indici dinamici
```

**Esempio reale**:
```
1.0.8802.1.1.2.1.4.1.1.9.0.6.1 = "21_CED_1_L3"
1.0.8802.1.1.2.1.4.1.1.9.0.7.1 = "21_CED_2_L2"
1.0.8802.1.1.2.1.4.1.1.9.0.8.1 = "21_PDV_01"
```

Gli indici `.0.6.1`, `.0.7.1`, `.0.8.1` cambiano per ogni device e porta!

### Uso corretto con session.subtree()

```javascript
async function testLLDP(ip, community) {
  const session = snmp.createSession(ip, community, {
    timeout: 3000,
    version: snmp.Version2c
  });

  return new Promise((resolve) => {
    let found = false;

    // WALK sulla tabella LLDP Remote
    session.subtree(
      LLDP_REMOTE_SYSNAME,
      5, // maxRepetitions (basta trovarne qualcuno)
      (varbinds) => {
        // Callback per ogni risultato
        for (const vb of varbinds) {
          if (!snmp.isVarbindError(vb)) {
            found = true; // Trovato almeno un neighbor!
          }
        }
      },
      (error) => {
        // Callback finale
        session.close();

        if (error) {
          resolve(false); // Timeout o errore SNMP
        } else {
          resolve(found); // LLDP attivo se ha trovato neighbor
        }
      }
    );
  });
}
```

## Logica del test

1. **WALK sulla tabella lldpRemSysName**: Attraversa tutti gli OID `.1.0.8802.1.1.2.1.4.1.1.9.*`
2. **Se trova almeno un varbind valido**: LLDP è attivo e ha neighbor
3. **Se il WALK completa senza risultati**: LLDP non è abilitato o non ha neighbor
4. **Se il WALK va in timeout**: Device non supporta LLDP o tabella inaccessibile

## Vantaggi

✅ **Zero falsi positivi**: Se trova neighbor, LLDP funziona davvero
✅ **Robusto**: Funziona con qualsiasi vendor (Cisco, Huawei, HP, etc.)
✅ **Efficiente**: `maxRepetitions=5` limita il traffico SNMP
✅ **Diagnostico**: Se il WALK restituisce zero neighbor, sai che LLDP è disabilitato o non funzionante

## Confronto con GET

| Metodo | OID | Risultato | Affidabilità |
|--------|-----|-----------|--------------|
| GET | `1.0.8802.1.1.2.1.1.1.0` (lldpMessageTxInterval) | Valore numerico | ❌ Può esistere anche senza neighbor |
| WALK | `1.0.8802.1.1.2.1.4.1.1.9` (lldpRemSysName) | Lista neighbor | ✅ Se restituisce dati, LLDP funziona |

## Script Aggiornati

### check-lldp-failures.mjs
Script principale che verifica tutti i device nel DB usando il metodo WALK.

### test-lldp-walk.mjs
Script di test rapido per verificare LLDP su un singolo device:
```bash
node test-lldp-walk.mjs 192.168.1.2 public
```

## Reference MIB

MIB IEEE 802.1AB (LLDP):
- `lldpRemTable`: `.1.0.8802.1.1.2.1.4.1`
- `lldpRemSysName`: `.1.0.8802.1.1.2.1.4.1.1.9`
- `lldpRemPortId`: `.1.0.8802.1.1.2.1.4.1.1.7`
- `lldpRemChassisId`: `.1.0.8802.1.1.2.1.4.1.1.5`

Tutti questi OID hanno indici dinamici e richiedono WALK, non GET.
