// IP Fabric MAC Search Client
// Chiamata al database PostgreSQL IP Fabric Discovery

const IP_FABRIC_URL = "http://localhost:8000/api/v1/internal";

export async function searchMacIpFabric(mac) {
  console.log("[IP-FABRIC] Searching for MAC: " + mac);
  try {
    const url = IP_FABRIC_URL + "/mac-search/" + encodeURIComponent(mac);
    console.log("[IP-FABRIC] Fetching: " + url);

    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    console.log("[IP-FABRIC] Response status: " + response.status);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.log("[IP-FABRIC] Error: " + response.status + " - " + (err.detail || err.error || "unknown"));
      return null;
    }

    const data = await response.json();
    console.log("[IP-FABRIC] Found: " + data.found + ", source: " + data.source);
    return data;
  } catch (err) {
    console.log("[IP-FABRIC] Fetch error: " + err.message);
    return null;
  }
}

export async function getIpFabricStats() {
  try {
    const response = await fetch(IP_FABRIC_URL + "/mac-stats", {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.log("[IP-FABRIC] Stats error: " + err.message);
    return null;
  }
}
