const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const PRIVATE_PDF_DIR = path.join(ROOT_DIR, ".private-assets", "pdfs");

const PRODUCTS = {
  "essenskarten-komplett": {
    id: "essenskarten-komplett",
    title: "Essens-Karteikarten PDF · 5 Sprachen",
    description: "Ein Komplett-PDF mit Essens-Karteikarten in Deutsch, Englisch, Spanisch, Französisch und Latein.",
    subject: "5 Sprachen",
    level: "Mehrsprachiges Komplettset",
    priceCents: 1290,
    currency: "EUR",
    fileName: "essenskarten-komplett.pdf"
  }
};

function formatEuro(cents) {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR"
  }).format(cents / 100);
}

function serializeProduct(product) {
  return {
    id: product.id,
    title: product.title,
    description: product.description,
    subject: product.subject,
    level: product.level,
    priceCents: product.priceCents,
    currency: product.currency,
    formattedPrice: formatEuro(product.priceCents)
  };
}

function getProduct(productId) {
  const product = PRODUCTS[productId];
  if (!product) {
    return null;
  }

  return {
    ...product,
    filePath: path.join(PRIVATE_PDF_DIR, product.fileName)
  };
}

function listProducts() {
  return Object.values(PRODUCTS).map(serializeProduct);
}

module.exports = {
  formatEuro,
  getProduct,
  listProducts
};