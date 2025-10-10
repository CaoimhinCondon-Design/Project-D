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
