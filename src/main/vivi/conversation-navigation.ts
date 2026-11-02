type PetConversationNavigation = {
  isBotConversation: (id: string) => boolean;
  openVivi: (conversationId?: string) => void;
  openChat: (conversationId: string) => Promise<unknown>;
};

/** Bot conversations stay in Vivi; opening them must not change the ordinary chat. */
export async function openPetConversation(
  navigation: PetConversationNavigation,
  conversationId?: string,
  legacyRunId?: string,
): Promise<void> {
  if (!conversationId || legacyRunId || navigation.isBotConversation(conversationId)) {
    navigation.openVivi(legacyRunId ?? conversationId);
    return;
  }
  await navigation.openChat(conversationId);
}
