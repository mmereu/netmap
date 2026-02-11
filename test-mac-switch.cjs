const { Client } = require("ssh2");
const conn = new Client();

conn.on("ready", () => {
  console.log("SSH Connected to switch");
  conn.shell((err, stream) => {
    if (err) {
      console.error("Shell error:", err);
      conn.end();
      return;
    }
    
    let output = "";
    let commandSent = false;
    
    stream.on("data", (d) => {
      output += d.toString();
      process.stdout.write(d.toString());
      
      // Quando vediamo il prompt, inviamo il comando
      if (!commandSent && output.includes(">")) {
        commandSent = true;
        stream.write("display mac-address 0000-484a-7860\n");
      }
    });
    
    // Timeout per catturare output completo
    setTimeout(() => {
      console.log("\n\n=== FINE OUTPUT ===");
      conn.end();
    }, 5000);
  });
});

conn.on("error", (err) => {
  console.error("Connection error:", err.message);
});

conn.connect({
  host: process.env.SWITCH_HOST || "192.168.10.251",
  port: 22,
  username: process.env.SWITCH_SSH_USER || "admin",
  password: process.env.SWITCH_SSH_PASS || ""
});
