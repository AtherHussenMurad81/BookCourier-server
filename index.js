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

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
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
    const paymentCollection = db.collection("payments");
    const sellerRequestsCollection = db.collection("sellerRequests");
    const wishlistCollection = db.collection("wishlist");

    // Indexes
    await userCollection.createIndex({ email: 1 });

    // ==================== ALL ROUTES GO HERE ====================
    // role middlewares
    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await userCollection.findOne({ email });
      if (user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "Admin only Actions!", role: user?.role });

      next();
    };
    const verifyLibrarian = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await userCollection.findOne({ email });
      if (user?.role !== "Librarian")
        return res
          .status(403)
          .send({ message: "Librarian only Actions!", role: user?.role });

      next();
    };

    app.post("/books", async (req, res) => {
      const bookData = req.body;

      const result = await booksCollection.insertOne(bookData);
      console.log(result);
      res.send(result);
    });

    app.get("/books", async (req, res) => {
      const result = await booksCollection
        .find()
        .sort({ price: "asc" })
        .toArray();
      res.send(result);
    });
    // app.get("/fiveBooks", async (req, res) => {
    //   const result = await booksCollection
    //     .find()
    //     .sort({ price: "asc" })
    //     .limit(5)
    //     .toArray();
    //   res.send(result);
    // });

    app.get("/search", async (req, res) => {
      try {
        const search_text = req.query.search || "";
        const result = await booksCollection
          .find({ title: { $regex: search_text, $options: "i" } })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });
    app.get(
      "/dashboard/manage-books",

      async (req, res) => {
        const books = await booksCollection
          .find()
          .sort({
            price: "asc",
          })
          .toArray();
        // console.log(books);
        res.send(books);
      }
    );

    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id))
        return res.status(400).send({ message: "Invalid ID" });
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result || { message: "Book not found" });
    });
    app.get("/books/user/:email", async (req, res) => {
      const email = req.params.email;
      const books = await booksCollection
        .find({ "user.email": email })
        .toArray();
      console.log(books);
      res.send(books);
    });
    // PATCH /books/:id - update book fields
    app.patch("/books/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const updateData = req.body; // { name, author, image, category, price }

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid book ID" });
        }

        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Book not found" });
        }

        res.send({ success: true, message: "Book updated successfully" });
      } catch (err) {
        console.error("Update book error:", err);
        res.status(500).send({ error: err.message });
      }
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
    app.get("/user", verifyJWT, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });
    // update a user's role
    app.patch("/update-role", verifyJWT, verifyADMIN, async (req, res) => {
      const { email, role } = req.body;
      console.log("body", req.body);
      const result = await userCollection.updateOne(
        { email },
        { $set: { role } }
      );
      await sellerRequestsCollection.deleteOne({ email });

      res.send(result);
    });
    // get a user's role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await userCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });
    // Get all users
    app.get("/dashboard/all-user", async (req, res) => {
      try {
        const users = await userCollection.find().toArray();
        console.log("Fetched users from DB:", users); // <-- check this log
        res.send(users);
      } catch (err) {
        console.error(err);
        res.status(500).send({ error: err.message });
      }
    });
    app.patch("/dashboard/user/role/:id", async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;

      if (!["admin", "librarian"].includes(role)) {
        return res.status(400).send({ message: "Invalid role" });
      }

      try {
        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update role" });
      }
    });

    // Delete a user
    app.delete("/dashboard/user/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await userCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
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
    app.post("/orders", verifyJWT, async (req, res) => {
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
      // console.log("book data", book);
      if (!book) return res.status(404).send({ message: "Book not found" });
      // if (book.quantity < 1)
      //   return res.status(400).send({ message: "Out of stock" });

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

    // app.patch("/dashboard/payment-success", async (req, res) => {
    //   try {
    //     const sessionId = req.query.session_id;

    //     if (!sessionId) {
    //       return res.status(400).json({ message: "Session ID missing" });
    //     }

    //     // 🔹 Retrieve Stripe session
    //     const session = await stripe.checkout.sessions.retrieve(sessionId);

    //     // 🔹 Check payment status
    //     if (session.payment_status !== "paid") {
    //       return res.status(400).json({ message: "Payment not completed" });
    //     }

    //     // 🔹 Update order in DB
    //     const result = await orderCollection.updateOne(
    //       { sessionId },
    //       {
    //         $set: {
    //           status: "paid",
    //           transactionId: session.payment_intent,
    //           paidAt: new Date(),
    //         },
    //       }
    //     );

    //     res.send({
    //       success: true,
    //       transactionId: session.payment_intent,
    //       message: "Payment verified successfully",
    //     });
    //   } catch (error) {
    //     console.error(error);
    //     res.status(500).json({ message: "Payment verification failed" });
    //   }
    // });

    // My Inventory
    // app.get("/my-inventory/:email", async (req, res) => {
    //   const result = await booksCollection
    //     .find({ "user.email": req.params.email })
    //     .toArray();
    //   res.send(result);
    // });

    // User Role

    app.patch("/dashboard/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
          return res.status(400).json({ message: "Session ID missing" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const transactionId = session.payment_intent;

        // check if payment already exists
        const paymentExist = await paymentCollection.findOne({ transactionId });
        if (paymentExist) {
          return res.send({
            message: "Payment already exists",
            transactionId,
          });
        }

        console.log("payment status", session.payment_status);

        if (session.payment_status === "paid") {
          const bookId = session.metadata.bookId;
          const query = { bookId };
          // console.log("bookid", bookId);
          // update order in DB
          const update = {
            $set: {
              status: "paid",
              paymentStatus: "paid",
              transactionId,
            },
          };

          const result = await orderCollection.updateOne(query, update);
          // console.log("result", result);
          // create payment record
          const payment = {
            amount: session.amount_total / 100,
            currency: session.currency,
            customerEmail: session.customer_email,
            bookId: bookId,
            bookName: session.metadata.bookName || "", // ensure this is passed in Stripe metadata
            transactionId,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
          };

          const resultPayment = await paymentCollection.insertOne(payment);

          return res.send({
            success: true,
            modifiedOrder: result,
            transactionId,
            paymentInfo: resultPayment,
          });
        }

        return res.send({ success: false });
      } catch (error) {
        console.error("Payment Success Error:", error);
        res.status(500).json({ message: "Payment verification failed" });
      }
    });
    app.get("/dashboard/invoice", async (req, res) => {
      const result = await paymentCollection.find().toArray();
      console.log(result);
      res.send(result);
    });

    app.get("/user/role/:email", async (req, res) => {
      const user = await userCollection.findOne({ email: req.params.email });
      res.send({ role: user?.role || "user" });
    });
    // POST /wishlist
    app.post("/wishlist", verifyJWT, async (req, res) => {
      const { bookId, userEmail, bookImg, price, name } = req.body;
      console.log("wishlist", req.body);
      if (!bookId || !userEmail) {
        return res
          .status(400)
          .send({ message: "bookId and userEmail required" });
      }

      try {
        const existing = await wishlistCollection.findOne({
          bookId,
          userEmail,
          bookImg,
          price,
          name,
        });
        if (existing) {
          return res.status(400).send({ message: "Book already in wishlist" });
        }

        const result = await wishlistCollection.insertOne({
          bookId,
          userEmail,
          bookImg,
          price,
          name,
        });
        res.send({ success: true, data: result });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });
    app.get("/wishlist", async (req, res) => {
      const result = await wishlistCollection.find().toArray();
      res.send(result);
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
