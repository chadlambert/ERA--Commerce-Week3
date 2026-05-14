const express = require("express");
const router = express.Router();
const authenticateToken = require("../middleware/authenticateToken");
const authorizeRole = require("../middleware/authorizeRole");

const {getAllProducts, getProductsByCategory, getProductById, createProducts} = require("../controllers/productController");

router.get("/", authenticateToken, getAllProducts);
router.get("/category/:categoryId", authenticateToken, getProductsByCategory);
router.get("/:id", authenticateToken, getProductById);
router.post("/", authenticateToken, authorizeRole("Admin"), createProducts);
module.exports = router;