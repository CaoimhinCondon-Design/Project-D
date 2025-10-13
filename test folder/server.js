import 'dotenv/config';
let prompt = "Say 'double bubble bath' ten times fast."
import { OpenAI } from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

//prompt = "what is 1 + 1 in 1 charcter"

const stream = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
        {
            role: "system",
            content: "You are concise and helpful.",
            role: "user",
            content: prompt,
        },
    ],
    temperature: 0.2,
    stream: true,
});

let fullText = "";
for await (const event of stream) {
    if (event.type === 'response.output_text.delta'){
        fullText += event.delta;
        console.log(event.delta);
    }
}
console.log("Below is the fulltext \n\n");
console.log(fullText);

import express from 'express';

const app = express();

app.get('/stream', (req, res) => {
  // Tell the client to expect streamed text
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  // Send chunks of data every second
  let count = 0;
  const interval = setInterval(() => {
    count++;
    res.write(`Chunk #${count}\n`);

    if (count >= 5) { // stop after 5 chunks
      clearInterval(interval);
      res.end('Stream complete.\n');
    }
  }, 1000);

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(interval);
    console.log('Client disconnected');
  });
});

app.listen(3000, () => console.log('Listening on http://localhost:3000/stream'));