import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const githubId = 'prisma-seed-user';

  await prisma.user.upsert({
    where: { githubId },
    create: {
      githubId,
      username: 'prisma-seed-user',
      avatarUrl: 'https://example.invalid/avatar.png',
      githubAccessTokenEncrypted: 'seed-verification-value-not-a-token',
    },
    update: {
      username: 'prisma-seed-user',
    },
  });

  const seededUser = await prisma.user.findUniqueOrThrow({
    where: { githubId },
    select: { githubId: true, username: true },
  });

  console.info(`Seed verified for ${seededUser.githubId}.`);
}

main()
  .catch((error: unknown) => {
    console.error('Database seed failed.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
