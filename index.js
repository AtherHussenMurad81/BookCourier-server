require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 3000;

const app = express();

// Firebase Admin Setup
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN || "http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());

// JWT Verification
const verifyJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized Access!" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!" });
  }
};

const verifyUser = (req, res, next) => {
  verifyJWT(req, res, () => {
    if (req.tokenEmail !== req.params.email) {
      return res.status(403).send({ message: "Forbidden Access!" });
    }
    next();
  });
};

// MongoDB Client
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("BookCourier");
    const booksCollection = db.collection("books");
    const userCollection = db.collection("user");
    const orderCollection = db.collection("orders");

    // Indexes
    await userCollection.createIndex({ email: 1 });

    // ==================== ALL ROUTES GO HERE ====================

    app.post("/books", async (req, res) => {
      const bookData = req.body;

      const result = await booksCollection.insertOne(bookData);
      console.log(result);
      res.send(result);
    });

    app.get("/books", async (req, res) => {
      const result = await booksCollection.find().toArray();
      res.send(result);
    });

    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id))
        return res.status(400).send({ message: "Invalid ID" });
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result || { message: "Book not found" });
    });

    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.role = "user";
      userData.last_loggedIn = new Date().toISOString();

      const query = { email: userData.email };
      const existing = await userCollection.findOne(query);

      if (existing) {
        await userCollection.updateOne(query, {
          $set: { last_loggedIn: new Date().toISOString() },
        });
        return res.send({ message: "User updated" });
      }

      const result = await userCollection.insertOne(userData);
      res.send(result);
    });

    // My Orders
    app.get("/my-order/:email", async (req, res) => {
      console.log(req.params.email);
      const result = await orderCollection
        .find({ customerEmail: req.params.email })
        .sort({ orderedAt: -1 })
        .toArray();
      console.log(result);
      res.send(result);
    });
    // Place Order
    app.post("/orders", async (req, res) => {
      const {
        bookId,
        price,
        customerName,
        customerPhone,
        customerAddress,
        customerEmail,
      } = req.body;
      // console.log("token email", tokenEmail);
      if (!bookId || !price) {
        return res.status(400).send({ message: "Missing required fields" });
      }

      const book = await booksCollection.findOne({ _id: new ObjectId(bookId) });
      console.log("book data", book);
      if (!book) return res.status(404).send({ message: "Book not found" });
      if (book.quantity < 1)
        return res.status(400).send({ message: "Out of stock" });

      const newOrder = {
        bookId,
        name: book.name,
        author: book.author,
        image: book.image,
        category: book.category || "General",
        price: parseFloat(price),
        quantity: 1,
        status: "pending",
        paymentStatus: "unpaid",
        customerName,
        customerEmail: customerEmail,
        customerPhone,
        customerAddress,
        seller: book.user,
        orderedAt: new Date(),
      };

      const result = await orderCollection.insertOne(newOrder);
      // console.log("new orders", newOrder);

      await booksCollection.updateOne(
        { _id: new ObjectId(bookId) },
        { $inc: { quantity: -1 } }
      );

      res.send({ success: true, orderId: result.insertedId });
    });

    // payment updates

    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      // console.log("paymentInfo", paymentInfo);

      const amount = Number(paymentInfo.price) * 100;
      // console.log("Amount is here", amount);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.name}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          bookId: paymentInfo.bookId,
        },
        customer_email: paymentInfo.customerEmail,
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    // My Inventory
    // app.get("/my-inventory/:email", async (req, res) => {
    //   const result = await booksCollection
    //     .find({ "user.email": req.params.email })
    //     .toArray();
    //   res.send(result);
    // });

    // User Role
    app.get("/user/role/:email", async (req, res) => {
      const user = await userCollection.findOne({ email: req.params.email });
      res.send({ role: user?.role || "user" });
    });

    // Root Route
    app.get("/", (req, res) => {
      res.send("BookCourier Server is Running Successfully! 🚀");
    });

    // ==================== START SERVER ONLY AFTER DB CONNECT ====================
    app.listen(port, () => {
      console.log(`Server is running on http://localhost:${port}`);
    });

    // Ping test
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } catch (error) {
    console.error("Failed to start server:", error);
  }
}

// Start the app
run().catch(console.dir);
