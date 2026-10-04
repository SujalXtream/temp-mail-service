import net from "net";

const HOST = "127.0.0.1";
const PORT = 2525;

// IMPORTANT:
// Use the CURRENT address shown on your website.
const TO = "bac1028c9f1c@temp.local";

const FROM = "test@example.com";

const socket = net.createConnection(
  {
    host: HOST,
    port: PORT
  },
  () => {
    console.log(`Connected to SMTP ${HOST}:${PORT}`);
  }
);

socket.setEncoding("utf8");

let step = 0;

socket.on("data", (data) => {
  console.log("SMTP:", data.trim());

  const response = data.trim();

  if (step === 0 && response.includes("220")) {
    console.log("CLIENT: EHLO localhost");
    socket.write("EHLO localhost\r\n");
    step = 1;
    return;
  }

  if (step === 1 && response.includes("250")) {
    console.log(`CLIENT: MAIL FROM:<${FROM}>`);
    socket.write(`MAIL FROM:<${FROM}>\r\n`);
    step = 2;
    return;
  }

  if (step === 2 && response.includes("250")) {
    console.log(`CLIENT: RCPT TO:<${TO}>`);
    socket.write(`RCPT TO:<${TO}>\r\n`);
    step = 3;
    return;
  }

  if (step === 3 && response.includes("250")) {
    console.log("CLIENT: DATA");
    socket.write("DATA\r\n");
    step = 4;
    return;
  }

  if (step === 4 && response.includes("354")) {
    const email = [
      `From: ${FROM}`,
      `To: ${TO}`,
      "Subject: Phase 2 Test Email",
      "Date: " + new Date().toUTCString(),
      "",
      "Hello!",
      "",
      "This is a real SMTP test message.",
      "",
      "If you can see this message inside",
      "the Temp Mail website, Phase 2",
      "local email receiving is working.",
      "",
      "Regards,",
      "Temp Mail Test",
      "."
    ].join("\r\n");

    console.log("CLIENT: Sending email body...");
    socket.write(email + "\r\n");

    step = 5;
    return;
  }

  if (step === 5 && response.includes("250")) {
    console.log("");
    console.log("================================");
    console.log("EMAIL ACCEPTED BY SMTP SERVER");
    console.log("================================");
    console.log("");

    console.log("CLIENT: QUIT");
    socket.write("QUIT\r\n");

    step = 6;
    return;
  }

  if (step === 6 && response.includes("221")) {
    socket.end();
  }
});

socket.on("error", (error) => {
  console.error("");
  console.error("SMTP TEST ERROR:");
  console.error(error.message);
});

socket.on("close", () => {
  console.log("SMTP connection closed.");
});