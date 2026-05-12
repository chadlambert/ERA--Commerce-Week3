require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { connectMongo, getMongo } = require("./mongo");
const authenticateToken = require("./middleware/authenticateToken");
const authorizeRole = require("./middleware/authorizeRole");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "ERA Commerce API is running" });
});

//post /login
app.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const sql = "SELECT * FROM users WHERE email = ?";
  db.query(sql, [email], async (err, results) => {
    if (err) return res.status(500).json({ message: "Server error" });
    if (results.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN },
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
      },
    });
  });
});

//post /users
app.post("/users", async (req, res) => {
  const { first_name, last_name, email, password } = req.body;
  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({ message: "All fields are required" });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const sql =
      "INSERT INTO users (first_name, last_name, email, password) VALUES (?, ?, ?, ?)";
    db.query(
      sql,
      [first_name, last_name, email, hashedPassword],
      (err, result) => {
        if (err) {
          if (err.code === "ER_DUP_ENTRY") {
            return res
              .status(400)
              .json({ message: "Email already registered" });
          }
          return res.status(500).json({ message: "Server error" });
        }
        res.status(201).json({
          message: "user registered successfully",
          userId: result.insertId,
        });
      },
    );
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

//get /products
app.get("/products", authenticateToken, (req, res) => {
  const sql =
    "SELECT p.id, p.name, p.description, p.price, p.stock_quantity, c.name AS category_name FROM  products p INNER JOIN categories c ON p.category_id = c.id ORDER BY p.id ASC";
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: "Server error" });
    res.json(results);
  });
});

//get /products/category/:categoryId
app.get("/products/category/:categoryId", authenticateToken, (req, res) => {
  const { categoryId } = req.params;
  const sql =
    "SELECT p.id, p.name, p.description, p.price, p.stock_quantity, c.name AS category_name FROM products p INNER JOIN  categories c ON p.category_id = c.id WHERE p.category_id = ? ORDER BY p.id ASC";
  db.query(sql, [categoryId], (err, results) => {
    if (err) return res.status(500).json({ message: "Server error" });
    res.json(results);
  });
});

//get /products/:id
app.get("/products/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const sql =
    "SELECT p.id, p.name, p.description, p.price, p.stock_quantity, c.name AS category_name FROM products p INNER JOIN categories c ON p.category_id = c.id WHERE p.id = ?";
  db.query(sql, [id], async (err, results) => {
    if (err) return res.status(500).json({ message: "Server error" });
    if (results.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }
    const product = results[0];
    try {
      const mongo = getMongo();
      const reviews = await mongo
        .collection("product_reviews")
        .find({ product_id: parseInt(id) })
        .toArray();
      res.json({ ...product, reviews });
    } catch (mongoErr) {
      res.json({ ...product, reviews: [] });
    }
  });
});

//post /products
app.post(
  "/products",
  authenticateToken,
  authorizeRole("Admin"),
  async (req, res) => {
    const { name, description, price, stock_quantity, category_id } = req.body;
    if (!name || !price || !category_id) {
      return res
        .status(400)
        .json({ message: "Name, price, and category_id are required" });
    }
    const sql =
      "INSERT INTO products (name, description, price, stock_quantity, category_id) VALUES (?, ?, ?, ?, ?)";
    db.query(
      sql,
      [name, description, price, stock_quantity || 0, category_id],
      async (err, result) => {
        if (err) return res.status(500).json({ message: "Server error" });
        try {
          const mongo = getMongo();
          await mongo.collection("inventory_logs").insertOne({
            product_id: result.insertId,
            product_name: name,
            action: "restocked",
            quantity_change: stock_quantity || 0,
            previous_stock: 0,
            new_stock: stock_quantity || 0,
            timestamp: new Date(),
          });
        } catch (mongoErr) {
          console.error("MongoDB log failed: ", mongoErr.message);
        }
        res
          .status(201)
          .json({ message: "Product created", productId: result.insertId });
      },
    );
  },
);

//post /orders
app.post("/orders", authenticateToken, async (req, res) => {
  const { items } = req.body || {};
  const userId = req.user.id;
  if (!items || items.length === 0) {
    return res
      .status(400)
      .json({ message: "order mus contain atlest one item" });
  }
  db.beginTransaction(async (err) => {
    if (err) return res.status(500).json({ message: "Server error" });
    try {
      let totalAmount = 0;
      for (const item of items) {
        totalAmount += item.price_at_purchase * item.quantity;
      }
      const orderSql =
        "INSERT INTO orders (user_id, total_amount ) VALUES (?, ?)";
      const orderResult = await new Promise((resolve, reject) => {
        db.query(orderSql, [userId, totalAmount], (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
      const orderId = orderResult.insertId;
      for (const item of items) {
        const { product_id, quantity, price_at_purchase } = item;
        const subtotal = quantity * price_at_purchase;
        await new Promise((resolve, reject) => {
          const itemSql =
            "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, subtotal) VALUES (?, ?, ?, ?, ?)";
          db.query(
            itemSql,
            [orderId, product_id, quantity, price_at_purchase, subtotal],
            (err, r) => {
              if (err) reject(err);
              else resolve(r);
            },
          );
        });
        await new Promise((resolve, reject) => {
          const stockSql =
            "UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?";
          db.query(stockSql, [quantity, product_id, quantity], (err, r) => {
            if (err) reject(err);
            else if (r.affectedRows === 0)
              reject(new Error("insufficient stock"));
            else resolve(r);
          });
        });
      }
      db.commit(async (err) => {
        if (err) {
          return db.rollback(() => {
            res.status(500).json({ message: "Commit failed" });
          });
        }
        try {
          const mongo = getMongo();
          for (const item of items) {
            await mongo.collection("inventory_logs").insertOne({
              product_id: item.product_id,
              action: "sold",
              quantity_change: -item.quantity,
              timestamp: new Date(),
            });
          }
        } catch (mongoErr) {
          console.error("mongoDb log failed: ", MongoErr.message);
        }
        res.status(201).json({ message: "Order place", orderId });
      });
    } catch (err) {
      db.rollback(() => {
        res.status(400).json({ message: err.message || "order failed" });
      });
    }
  });
});

//get /orders
app.get("/orders", authenticateToken, (req, res) => {
  let sql;
  let params;
  if (req.user.role === "Admin") {
    sql =
      "SELECT o.id, o.status, o.total_amount, o.created_at, u.first_name, u.last_name, u.email FROM orders o INNER JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC";
    params = [];
  } else {
    sql =
      "SELECT id, status, total_amount, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC";
    params = [res.user.id];
  }
  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ message: "Server error" });
    res.json(results);
  });
});

//get /orders /my
app.get("/orders/my", authenticateToken, (req, res) => {
  const sql =
    "SELECT id, status, total_amount, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC";
  db.query(sql, [req.user.id], (err, results) => {
    if (err) return res.status(500).json({ message: "Server error" });
    res.json(results);
  });
});

//get /orders/:id
app.get("/orders/:id", authenticateToken, (req, res) => {
  const { id } = req.params;
  const sql =
    "SELECT o.id AS order_id, o.status, o.total_amount, o.created_at, oi.id AS item_id, oi.price_at_purchase, oi.subtotal, p.name AS product_name FROM orders o INNER JOIN order_items oi ON oi.order_id = o.id INNER JOIN products p ON p.id = oi.product_id WHERE o.id = ? ORDER BY oi.id ASC";
  db.query(sql, [id], (err, results) => {
    if (err) return res.status(500).json({ message: "Server error" });
    if (results.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.json(results);
  });
});

//get /categories
app.get("/categories", authenticateToken, (req, res) => {
  const sql =
    "SELECT c.id, c.name, c.description, COUNT(p.id) AS product_count FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id,c.name, c.description ORDER BY c.id ASC";
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: "Server error" });
    res.json(results);
  });
});

//post /reviews
app.post("/reviews", authenticateToken, async (req, res) => {
  const { product_id, rating, review_text } = req.body;

  if (!product_id || !rating || !review_text) {
    return res
      .status(400)
      .json({ message: "product_id, rating, review_text are required" });
  }

  if (rating < 1 || rating > 5) {
    return res.status(400).json({ message: "rating must be between 1 and 5" });
  }

  try {
    const mongo = getMongo();
    const result = await mongo.collection("product_reviews").insertOne({
      product_id: parseInt(product_id),
      user_id: req.user.id,
      first_name: req.user.email.split("@")[0],
      rating: parseInt(rating),
      review_text,
      created_at: new Date(),
    });
    res
      .status(201)
      .json({ message: "Review submitted", reviewId: result.insertId });
  } catch (err) {
    console.error("review error: ", err);
    res.status(500).json({ message: "Server error" });
  }
});

//get /reports/sales
app.get("/reports/sales", authenticateToken, authorizeRole("Admin"), (req, res) => {
  const sql ='SELECT COUNT(*)  AS total_orders, SUM(total_amount) AS total_revenue, AVG(total_amount) AS average_order_value, MAX(total_amount) AS highest_order, MIN(total_amount) AS lowest_order FROM orders';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({message: 'Server error'});
    res.json(results [0]);
  });
});

//get /reports/top-products
app.get("/reports/top-products", authenticateToken, authorizeRole("Admin"), (req, res) => {
  const sql = 'SELECT p.id, p.name AS product_name, SUM(oi.quantity) AS total_sold, SUM(oi.subtotal) AS total_revenue FROM order_items oi INNER JOIN products p ON p.id = oi.product_id GROUP BY p.id, p.name ORDER BY total_sold DESC LIMIT 10';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({message: 'Server error'});
    res.json(results);
  });
});

//get /reports/category-sales
app.get("/reports/category-sales", authenticateToken, authorizeRole("Admin"), (req, res) => {
  const sql = 'SELECT c.id, c.name AS category_name, COUNT(oi.id) AS total_orders, SUM(oi.subtotal) AS total_revenue, AVG(oi.subtotal) AS average_item_vale FROM order_items oi INNER JOIN products p ON p.id = oi.product_id RIGHT JOIN categories c ON c.id = p.category_id GROUP BY c.id, c.name HAVING SUM(oi.subtotal) > 0 ORDER BY total_revenue DESC';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({message: 'Server error'});
    res.json(results);
  });
});

//get /inventory
app.get("/inventory", authenticateToken, authorizeRole("Admin"), (req, res) => {
  const sql =' SELECT p.id, p.name, p.stock_quantity, c.name AS category_name, CASE WHEN p.stock_quantity > 10 THEN "in_stock" WHEN p.stock_quantity > 0 THEN "low_stock" ELSE "out_of_stock" END AS stock_status FROM products p INNER JOIN categories c ON c.id = p.category_id ORDER BY p.stock_quantity ASC';
  db.query(sql, (err, results) => {
    if(err) return res.status(500).json({message: 'Server error'});
    res.json(results);
  });
});


async function startServer() {
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
