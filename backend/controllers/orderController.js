const db = require("../db");
const {getMongo} = require("../mongo");
const createOrder = async (req, res) => {
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
};

const getAllOrders = (req, res) => {
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
};

const getMyOrders = (req, res) => {
  const sql =
    "SELECT id, status, total_amount, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC";
  db.query(sql, [req.user.id], (err, results) => {
    if (err) return res.status(500).json({ message: "Server error" });
    res.json(results);
  });
};

const getOrderById = (req, res) => {
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
};

module.exports ={createOrder, getAllOrders, getMyOrders, getOrderById};