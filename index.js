require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
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
// assignment11 T3R2vlQsE5vpKH1H
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("BookCourier");
    const booksCollection = db.collection("books");
    const userCollection = db.collection("user");
    const orderCollection = db.collection("orders");

    app.post("/books", async (req, res) => {
      const bookData = req.body;
      // console.log(bookData);
      const result = await booksCollection.insertOne(bookData);
      res.send(result);
    });
    app.get("/books", async (req, res) => {
      const result = await booksCollection.find().toArray();
      res.send(result);
    });

    // get all plants from db

    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      const result = await booksCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // save the user

    app.post("/user", async (req, res) => {
      const userData = req.body;
      // console.log("User data", userData);
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "user";

      const query = {
        email: userData.email,
      };
      // console.log(userData);
      const alreadyExists = await userCollection.findOne(query);
      if (alreadyExists) {
        const result = await userCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      } else {
        const result = await userCollection.insertOne(userData);
        res.send(result);
      }
    });

    // Payment Entry Point

    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      console.log(paymentInfo);

      const session = await stripe.checkout.sessions.create({
        // success_url: `${process.env.CLIENT_DOMAIN}/payment-success`,
        // cancel_url: `${process.env.CLIENT_DOMAIN}/book/${paymentInfo?.bookId}`,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.name,
              },
              unit_amount: parseInt(paymentInfo?.price) * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          bookId: paymentInfo?.bookId,
          customer: paymentInfo?.customer?.email,
          seller: paymentInfo?.seller.name,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/book/${paymentInfo?.bookId}`,
      });
      res.send({ url: session.url });
    });
    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // console.log(session);
      const book = await booksCollection.findOne({
        _id: new ObjectId(session.metadata.bookId),
      });
      console.log("Book id", book);

      // checking two times or data

      const order = await booksCollection.findOne({
        transactionId: session.payment_intent,
      });
      if (session.status === "complete" && book && !order) {
        // save in db

        const orderInfo = {
          bookId: session.metadata.bookId,
          transactionId: session.payment_intent,
          customer: session.metadata.customer,
          status: "pending",
          name: book.name,
          seller: book.user,
          author: book.author,
          quantity: 1,
          price: session.amount_total / 100,
          image: book?.image,
        };
        // console.log(orderInfo);
        const result = await orderCollection.insertOne(orderInfo);

        // update book quantity

        await booksCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.bookId),
          },
          {
            $inc: { quantity: -1 },
          }
        );
        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,
        });
      }
      res.send(
        res.send({
          transactionId: session.payment_intent,
          orderId: order._id,
        })
      );
    });

    // get all orders for a seller by email------->

    app.get("/manage-orders/:email", async (req, res) => {
      const email = req.params.email;

      const result = await orderCollection
        .find({ "seller.email": email })
        .toArray();
      res.send(result);
    });

    // my order
    app.get("/my-order/:email", async (req, res) => {
      const email = req.params.email;
      console.log("Request of token email", req.tokenEmail);
      const result = await orderCollection.find({ customer: email }).toArray();
      res.send(result);
    });
    // get all plants for a seller by email
    app.get(
      "/my-inventory/:email",

      async (req, res) => {
        const email = req.params.email;

        const result = await booksCollection
          .find({ "user.email": email })
          .toArray();
        res.send(result);
      }
    );
    // get a users role

    app.get("/user/role/:email", async (req, res) => {
      const email = req.params.email;
      const result = await userCollection.findOne({ email });
      res.send({ role: result?.role });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
