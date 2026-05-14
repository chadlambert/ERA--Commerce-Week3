require("dotenv").config();
const express = require("express");
const cors= require("cors");
const {connectMongo} = require("./mongo");
const errorHandler = require("./middleware/errorHandlers");
const authRouter = require("./routes/auth");
const productRouter = require("./routes/products");
const orderRouter = require("./routes/orders");
const categoryRouter = require("./routes/categories");
const reportRouter = require("./routes/reports");
const reviewRouter = require("./routes/reviews");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.use("/auth", authRouter);
app.use("/products", productRouter);
app.use("/orders", orderRouter);
app.use("/categories", categoryRouter);
app.use("/reports", reportRouter);
app.use("/reviews", reviewRouter);
app.use("/inventory", reportRouter);
app.use(errorHandler);

async function startServer() {
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
