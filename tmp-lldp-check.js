const { Client } = require("ssh2");
const conn = new Client();

conn.on("ready", () => {
  console.log("Connected to switch 192.168.10.251");
  conn.shell((err, stream) => {
    if (err) throw err;
    
    let output = "";
    let commandsSent = 0;
    const commands = [
      "display lldp neighbor interface XGE1/0/28",
      "display lldp neighbor brief | include XGE1/0/28",
      "display interface XGE1/0/28"
    ];
    
    stream.on("close", () => {
      console.log("\n=== FINAL OUTPUT ===");
      console.log(output);
      conn.end();
    });
    
    stream.on("data", (data) => {
      output += data.toString();
      
      // Check for prompt
      if (output.includes("<10_L3>") || output.includes("[10_L3]")) {
        if (commandsSent < commands.length) {
          console.log("\n>>> Sending: " + commands[commandsSent]);
          stream.write(commands[commandsSent] + "\n");
          commandsSent++;
        } else if (commandsSent === commands.length) {
          commandsSent++;
          setTimeout(() => stream.end(), 2000);
        }
      }
    });
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
