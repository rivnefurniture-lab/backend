import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const data = [
  {"author": null, "text": "Losers guess. Winners backtest. (ще думаю)", "photo": null},
  {"author": null, "text": "Before trading felt like straight-up gambling. Now I see what works before I even risk a cent", "photo": null},
  {"author": null, "text": "Feels like having a financial advisor in your pocket, except this one doesn’t charge fees or talk down to you. Just clear strategies that run on their own. Perfect.", "photo": null},
  {"author": null, "text": "This AI advisor sucks? Nobody’s saying that after using Algotcha and stacking gains", "photo": null},
  {"author": null, "text": "I hated handing my money to someone else. With this, I keep control but still get that advisor-level structure, fully automated", "photo": null},
  {"author": null, "text": "Feels like Wall Street brains on autopilot, but simple enough that I can run it and make gains.", "photo": null},
  {"author": null, "text": "Why pay some guy 2% to manage your money when Algotcha does the same thing for a fraction of the cost and never sleeps?", "photo": null},
  {"author": null, "text": "Even my golden retriever could run a strategy here and still come out ahead. Algotcha makes complex stuff stupid easy.", "photo": null},
  {"author": null, "text": "I’m lazy. That’s why I love it. My strategy runs itself and the money shows up.", "photo": null},
  {"author": null, "text": "Trading isn’t luck anymore, it’s tools. Algotcha makes it simple. I wish I had it years ago before I torched cash guessing", "photo": null},
  {"author": null, "text": "Using Algotcha is like letting your smart friend take the test for you while you chill. Making gains has never been this easy lol", "photo": null}
];
const run = async () => {
  for (const c of data) { await prisma.comment.create({ data: c }); }
  console.log('Seeded', data.length, 'comments');
};
run().finally(()=>prisma.$disconnect());
