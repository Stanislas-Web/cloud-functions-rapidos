const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");
const logger = require("firebase-functions/logger");

// Initialiser Firebase Admin avec la configuration explicite
initializeApp({
  projectId: "rapidos-21203",
});

const db = getFirestore();
const messaging = getMessaging();

// 🔔 NOTIFICATION POUR COMMANDE
exports.sendNotificationOnNewOrder = onDocumentCreated(
    {
      document: "commandes/{commandeId}",
      region: "us-central1",
      maxInstances: 10,
    },
    async (event) => {
      const newOrder = event.data.data();
      logger.info("📦 Nouvelle commande :", {order: newOrder});

      const tokensSnapshot = await db.collection("tokens").get();
      logger.info("🔑 Tokens trouvés:", {
        count: tokensSnapshot.size,
        tokens: tokensSnapshot.docs.map((doc) => doc.id),
      });

      const tokens = tokensSnapshot.docs.map((doc) => doc.id);
      const validTokens = tokens.filter((token) => token && token.length > 0);
      if (validTokens.length === 0) {
        logger.warn("❌ Aucun token valide disponible");
        return;
      }

      const sendPromises = validTokens.map((token) => {
        const message = {
          notification: {
            title: "Nouvelle commande !",
            body: "Une commande est disponible sur Rapidos.",
          },
          token: token,
          android: {
            notification: {
              sound: "custom_sound",
              priority: "high",
              channelId: "order_notifications",
            },
          },
          apns: {
            payload: {
              aps: {
                sound: "custom_sound.caf",
                contentAvailable: true,
                mutableContent: true,
                badge: 1,
              },
            },
          },
        };

        logger.info("📤 Envoi de la notification:", {token, message});
        return messaging.send(message)
            .then(() => ({token, success: true}))
            .catch((error) => {
              logger.error("❌ Erreur d'envoi de notification", {
                token,
                error: error.message,
                code: error.code,
              });
              return {token, success: false, error};
            });
      });

      const results = await Promise.all(sendPromises);
      const successCount = results.filter((r) => r.success).length;
      logger.info(`✅ ${successCount} notifications envoyées.`);
    },
);

// 🔔 NOTIFICATION POUR VENDEUR SUR NOUVEAU PANIER
exports.notifySellerOnNewCart = onDocumentCreated(
    {
      document: "carts/{cartId}",
      region: "us-central1",
      maxInstances: 10,
    },
    async (event) => {
      const cartData = event.data.data();
      logger.info("🛒 Nouveau panier :", {cart: cartData});

      const item = cartData.items && cartData.items[0];
      if (!item || !item.idVendeur) {
        logger.warn("❗️Aucun vendeur trouvé dans l'item");
        return;
      }

      const idVendeur = item.idVendeur;

      const tokenSnapshot = await db
          .collection("tokens")
          .where("userId", "==", idVendeur)
          .get();

      if (tokenSnapshot.empty) {
        logger.warn(`❌ Aucun token trouvé pour le vendeur ${idVendeur}`);
        return;
      }

      const token = tokenSnapshot.docs[0].data().token;

      const message = {
        notification: {
          title: "Nouvelle commande reçue !",
          body: `Un client a commandé : ${item.name}`,
        },
        token: token,
        android: {
          notification: {
            sound: "notification_sound",
            priority: "high",
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "custom_sound.caf",
              contentAvailable: true,
              mutableContent: true,
              badge: 1,
            },
          },
        },
      };

      logger.info("📤 Envoi de la notification au vendeur:", {token, message});
      await messaging.send(message);
      logger.info("✅ Notification envoyée avec succès au vendeur", {token});
    },
);

// 🔔 NOTIFICATION POUR COMMANDE REJETÉE
exports.notifyClientOnRejectedCart = onDocumentUpdated(
    {
      document: "carts/{cartId}",
      region: "us-central1",
      maxInstances: 10,
    },
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();

      if (!before || !after) {
        logger.warn("❗️Données manquantes dans before/after");
        return;
      }

      const wasRejected = before.status === "rejected";
      const isRejected = after.status === "rejected";

      if (isRejected && !wasRejected) {
        const idClient = after.idClient;
        const reason = after.rejectionReason || "Commande rejetée.";

        if (!idClient) {
          logger.warn("❌ Aucun idClient trouvé pour la commande rejetée.");
          return;
        }

        const tokenSnapshot = await db
            .collection("tokens")
            .where("userId", "==", idClient)
            .get();

        if (tokenSnapshot.empty) {
          logger.warn(`❌ Aucun token trouvé pour le client ${idClient}`);
          return;
        }

        const token = tokenSnapshot.docs[0].data().token;

        const message = {
          notification: {
            title: "Commande rejetée ❌",
            body: `Votre commande a été rejetée : ${reason}`,
          },
          token: token,
          android: {
            notification: {
              sound: "rejection_sound",
              priority: "high",
            },
          },
          apns: {
            payload: {
              aps: {
                sound: "custom_sound.caf",
                contentAvailable: true,
                mutableContent: true,
                badge: 1,
              },
            },
          },
        };

        logger.info(
            "📤 Envoi de la notification de rejet au client",
            {token, message},
        );
        await messaging.send(message);
        logger.info(
            "✅ Notification de rejet envoyée avec succès",
            {idClient},
        );
      }
    },
);

exports.notifyDeliveryOnReadyToShip = onDocumentUpdated(
    {
      document: "carts/{cartId}",
      region: "us-central1",
      maxInstances: 10,
    },
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();

      if (!before || !after) {
        logger.warn("❗️Données manquantes pour before/after");
        return;
      }

      const wasReady = before.status === "pret_a_expedier";
      const isReady = after.status === "pret_a_expedier";

      if (!wasReady && isReady) {
        logger.info(
            "📦 Commande prête à expédier :",
            {cartId: event.params.cartId},
        );

        const tokensSnapshot = await db
            .collection("tokens")
            .where("role", "==", "livreur")
            .get();

        if (tokensSnapshot.empty) {
          logger.warn("❌ Aucun livreur trouvé");
          return;
        }

        const tokens = tokensSnapshot.docs
            .map((doc) => doc.data().token)
            .filter(Boolean);

        const sendPromises = tokens.map((token) => {
          const message = {
            notification: {
              title: "Commande prête à livrer 🚚",
              body: "Une commande est prête à être livrée.",
            },
            token: token,
            android: {
              notification: {
                sound: "custom_sound",
                priority: "high",
                channelId: "order_notifications",
              },
            },
            apns: {
              payload: {
                aps: {
                  sound: "custom_sound.caf",
                  contentAvailable: true,
                  mutableContent: true,
                  badge: 1,
                },
              },
            },
          };

          return messaging.send(message)
              .then(() => ({token, success: true}))
              .catch((error) => {
                logger.error("❌ Erreur d'envoi à un livreur", {
                  token,
                  error: error.message,
                });
                return {token, success: false};
              });
        });

        const results = await Promise.all(sendPromises);
        const successCount = results.filter((r) => r.success).length;

        logger.info(
            `✅ ${successCount} notifications envoyées aux livreurs.`,
        );
      }
    },
);

// 🔔 NOTIFICATION POUR CLIENT - COMMANDE EN ROUTE
exports.notifyClientOnDeliveryStarted = onDocumentUpdated(
    {
      document: "carts/{cartId}",
      region: "us-central1",
      maxInstances: 10,
    },
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();

      if (!before || !after) {
        logger.warn("❗️Données manquantes pour before/after");
        return;
      }

      const wasOnTheWay = before.status === "en route pour livraison";
      const isNowOnTheWay = after.status === "en route pour livraison";

      if (!wasOnTheWay && isNowOnTheWay) {
        const idClient = after.idClient;
        const shortcode = after.shortCode || "Aucun code fourni";

        if (!idClient) {
          logger.warn("❌ idClient manquant dans le document cart.");
          return;
        }

        const tokenSnapshot = await db
            .collection("tokens")
            .where("userId", "==", idClient)
            .get();

        if (tokenSnapshot.empty) {
          logger.warn(`❌ Aucun token trouvé pour le client ${idClient}`);
          return;
        }

        const token = tokenSnapshot.docs[0].data().token;

        const message = {
          notification: {
            title: "Votre commande est en route ! 🛵",
            body: `Votre code de livraison est : ${shortcode}`,
          },
          token: token,
          android: {
            notification: {
              sound: "rejection_sound",
              priority: "high",
            },
          },
          apns: {
            payload: {
              aps: {
                sound: "custom_sound.caf",
                contentAvailable: true,
                mutableContent: true,
                badge: 1,
              },
            },
          },
        };

        logger.info(
            "📤 Envoi de la notification au client :",
            {token, shortcode},
        );
        await messaging.send(message);
        logger.info("✅ Notification envoyée avec succès au client", {idClient});
      }
    },
);


