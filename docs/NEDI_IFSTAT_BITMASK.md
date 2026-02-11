# NeDi ifstat Bitmask Interpretation

## Scoperta Importante

NeDi NON usa i valori standard SNMP `ifOperStatus` (1=up, 2=down, 3=testing).

Invece, NeDi memorizza `ifstat` come **BITMASK**:

| Bit | Valore | Significato |
|-----|--------|-------------|
| 0   | 1      | Admin UP    |
| 1   | 2      | Oper UP     |

## Combinazioni

| ifstat | Binario | Admin | Oper  | Significato      | Classe NeDi |
|--------|---------|-------|-------|------------------|-------------|
| 0      | 0b00    | DOWN  | DOWN  | Disabled         | -           |
| 1      | 0b01    | UP    | DOWN  | No link          | warn        |
| 2      | 0b10    | DOWN  | UP    | Admin off        | -           |
| 3      | 0b11    | UP    | UP    | Fully operational| good        |

## Codice PHP NeDi (libdev.php)

```php
function Ifdbstat($s){
    if( ($s & 3) == 3 ){
        $sc = 'good';   // Both admin and oper UP
    }elseif( $s & 1 ){
        $sc = 'warn';   // Admin up, oper down
    }elseif( $s & 2 ){
        $sc = 'good';   // Oper up (admin not considered)
    }else{
        $sc = 'nok';    // Both down
    }
    return $sc;
}
```

## Implementazione JavaScript (device-panel.js)

```javascript
const ifstat = port.ifoperstatus || 0;
const adminUp = (ifstat & 1) !== 0;
const operUp = (ifstat & 2) !== 0;

if (adminUp && operUp) {
    statusLabel = 'up';
} else if (adminUp && !operUp) {
    statusLabel = 'down';
} else if (!adminUp && operUp) {
    statusLabel = 'admin-off';
} else {
    statusLabel = 'disabled';
}
```

## Database NeDi

- Tabella: `interfaces`
- Colonna: `ifstat` (mappata come `ifoperstatus` in libnedi.js)
- `pvid` contiene il VLAN ID

## File Modificati

- `public/device-panel.js` - Aggiunta colonna VLAN e fix interpretazione status

## Data

2024-11-29
