# NetMap AI Chat - MAC Search Design

> Data: 2025-12-22
> Autore: Brainstorming Session
> Stato: APPROVATO

---

## Overview

Interfaccia conversazionale autonoma per ricerca MAC address, con agenti AI che decidono la strategia migliore (DB NeDi + SSH live).

### Obiettivi

1. Pagina chat dedicata stile ChatGPT
2. Agenti AI autonomi (no scelte manuali utente)
3. Risultati progressivi (prima DB, poi SSH)
4. Card espandibili con azioni contestuali
5. Preview panel per dettagli estesi
6. Custom branding integrato

---

## URL Structure

```
/ai/                 → Redirect a /ai/chat
/ai/chat             → Chat principale MAC search
/ai/history          → Storico conversazioni (futuro)
/ai/settings         → Impostazioni agenti (futuro)
```

---

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  [LOGO IPER]         NetMap AI Assistant            [≡ Menu]   │
├───────────────────────────────────────┬─────────────────────────┤
│                                       │                         │
│           CHAT AREA                   │      PREVIEW PANEL      │
│           (60% width)                 │       (40% width)       │
│                                       │                         │
│  - Messaggi utente/bot                │  - Mini mappa           │
│  - Card risultati espandibili         │  - Device info          │
│  - Azioni contestuali                 │  - Porta dettagli       │
│                                       │  - Storico MAC          │
│                                       │  - Azioni rapide        │
├───────────────────────────────────────┤                         │
│  [📎] Scrivi messaggio...    [Invia]  │                         │
└───────────────────────────────────────┴─────────────────────────┘
```

### Responsive

- **Desktop (>1200px)**: Layout 60/40
- **Tablet (768-1200px)**: Chat 100%, preview drawer
- **Mobile (<768px)**: Solo chat, preview modal

---

## Palette Colori

### Background (Dark Theme)
```css
--bg-base: #1a1a2e;        /* Sfondo principale */
--bg-panel: #16213e;       /* Chat area, preview */
--bg-card: #1f2940;        /* Messaggi, risultati */
--bg-hover: #2a3a5a;       /* Interazioni */
```

### Brand Colors
```css
--brand-red: #E31E24;       /* Accenti primari */
--brand-red-hover: #ff3333; /* Hover buttons */
--brand-red-soft: rgba(227,30,36,0.2); /* Badge */
```

### Stati
```css
--success: #00d26a;        /* Trovato, online */
--warning: #ffc107;        /* In corso, attenzione */
--error: #ff4757;          /* Non trovato, errore */
--info: #3b82f6;           /* Info, link */
```

### Testo
```css
--text-primary: #ffffff;   /* Titoli */
--text-secondary: #a0aec0; /* Descrizioni */
--text-muted: #64748b;     /* Timestamp */
--text-mono: #00ff88;      /* MAC, IP, dati tecnici */
```

---

## Tipografia

```css
--font-primary: 'Inter', 'Segoe UI', sans-serif;
--font-mono: 'JetBrains Mono', 'Consolas', monospace;

--text-xs: 11px;   /* timestamp, badge */
--text-sm: 13px;   /* label, hint */
--text-base: 15px; /* corpo messaggio */
--text-lg: 18px;   /* titoli card */
--text-xl: 24px;   /* header */
```

---

## Card Risultato

### Stato Compatto
```
┌────────────────────────────────────────────────────────┐
│ 🟢 MAC TROVATO                          DB + SSH ✓    │
├────────────────────────────────────────────────────────┤
│  aa:bb:cc:dd:ee:ff                                    │
│  📍 PDV_Core_10 (192.168.1.251) → GE1/0/15   VLAN 100   │
│  [Dettagli] [Storico] [Copia]              ▼ Espandi  │
└────────────────────────────────────────────────────────┘
```

### Stato Espanso
- Posizione attuale (switch, IP, porta, VLAN, fonte)
- Percorso (hop list)
- Ultimo movimento (date)
- Azioni complete (6 bottoni)

### Card Contestuali

**Non trovato:**
- Azioni: Riprova, Altra rete, Scan completo

**In corso (progressivo):**
- Progress bar per fasi
- Risultato parziale visibile

---

## Azioni Card

### Standard (sempre visibili)
1. 🔍 **Dettagli device** → apre info switch
2. 📜 **Storico MAC** → movimenti passati
3. 📋 **Copia** → copia in clipboard

### Estese (card espansa)
4. 🌐 **Apri topologia** → mostra in mappa
5. 🔄 **Refresh live** → forza check SSH
6. 📡 **Ping device** → test raggiungibilità

### Contestuali (dinamiche)
- Non trovato: "Cerca altra rete", "Espandi ricerca"
- Porta DOWN: "Abilita porta", "Log eventi"
- Errore: "Retry", "Segnala problema"

---

## Preview Panel

### Sezioni
1. **Mini Mappa** (200px height) - posizione visuale
2. **Device Info** - nome, IP, vendor, model, uptime, status
3. **Porta** - status, speed, duplex, VLAN, PoE
4. **Storico MAC** - lista movimenti con date
5. **Azioni Rapide** - ping, config, stats, topo, copy

### Stati
- Vuoto: "Seleziona un risultato"
- Caricamento: Skeleton loader
- Dati: Info complete
- Errore: Messaggio + retry

---

## Flusso AI Autonomo

### Processo Decisionale

```
1. NORMALIZZAZIONE
   - Riconosce formato MAC
   - Estrae filtri (rete, VLAN, sito)

2. QUERY DB NeDi (~20ms)
   - Mostra subito risultato parziale

3. DECISIONE:
   - Trovato + dati recenti → mostra, skip SSH
   - Trovato + dati vecchi → mostra + SSH verify
   - Non trovato → SSH scan completo

4. RISPOSTA FINALE
   - Card risultato
   - Suggerimenti contestuali
   - Popola Preview Panel
```

### Messaggi Progressivi

```
🤖 Cerco aa:bb:cc:dd:ee:ff...
   🔍 Query database NeDi...

🤖 ✅ Trovato nel database!
   📍 PDV_Core_10 → GE1/0/15
   🔄 Verifico stato live via SSH...

🤖 ✅ Confermato! Dati aggiornati.
   [CARD RISULTATO]
```

---

## File Structure

```
public/
└── ai/
    ├── chat.html      # Pagina principale
    ├── chat.css       # Stili dedicati
    └── chat.js        # Logica frontend
```

---

## API Utilizzate

```
POST /api/agent/chat           # Chat con agente AI
GET  /api/agent/status         # Status sistema agenti
POST /api/search/mac/hybrid    # Ricerca MAC (DB + SSH)
GET  /api/devices/:name/detail # Dettagli device
```

Nessuna modifica backend richiesta.

---

## Dipendenze

- **Font**: Inter (Google Fonts), JetBrains Mono
- **Icone**: Lucide icons (CDN)
- **Logo**: Custom (configurable)

---

## Implementazione

### Priorità File

1. `chat.html` - Struttura base + header con logo
2. `chat.css` - Stili completi
3. `chat.js` - Logica chat + card + panel

### Stima Complessità

- HTML: ~200 righe
- CSS: ~400 righe
- JS: ~300 righe

---

## Note

- Tema dark con accenti Iper mantiene coerenza brand
- Agenti AI già funzionanti, solo frontend nuovo
- Preview panel rende obsoleto mac-tracker-v2/v3 per uso chat
- Espandibile a futuro per altri agenti (device, topology)
