Lege deine geschützte PDF-Datei in den in `server/products.js` konfigurierten Pfad.

Aktueller Stand fuer `essenskarten-komplett`:

- .private-assets/LeonicAURA_Essen_v2.pdf

Produktiv auf Render empfohlen:

- /var/data/pdfs/LeonicAURA_Essen_v2.pdf

Dieser Ordner ist absichtlich nicht für die statische Auslieferung gedacht. Die Dateien werden nur über den Node-Endpoint /api/download/:token freigegeben.