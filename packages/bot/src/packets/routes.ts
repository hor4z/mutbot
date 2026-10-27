/**
 * GENERADO por extract-packets.ts — no editar a mano.
 *
 * Subconjunto de las clases de packets que el bot usa, extraído de
 * src/common/packets/*.ts del cliente MU JS. Ver AGENTS.md ("Trampas de protocolo") por qué el
 * bot no parsea el protocolo real con los XML del cliente.
 *
 * Para regenerar:  MU_SRC=~/self/mu/src bun run extract-packets.ts
 */

export type PacketRoute = { name: string; Name: string; Code: number; SubCode: number | null; HeaderType: string };

export const S2C_ROUTES: readonly PacketRoute[] = [
 {
  "name": "ConnectionInfoPacket",
  "Name": "ConnectionInfo",
  "Code": 244,
  "SubCode": 3,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ServerListResponsePacket",
  "Name": "ServerListResponse",
  "Code": 244,
  "SubCode": 6,
  "HeaderType": "C2HeaderWithSubCode"
 },
 {
  "name": "ServerListResponseOldPacket",
  "Name": "ServerListResponseOld",
  "Code": 244,
  "SubCode": 2,
  "HeaderType": "C2HeaderWithSubCode"
 },
 {
  "name": "HelloPacket",
  "Name": "Hello",
  "Code": 0,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "PatchVersionOkayPacket",
  "Name": "PatchVersionOkay",
  "Code": 2,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ClientNeedsPatchPacket",
  "Name": "ClientNeedsPatch",
  "Code": 5,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "GameServerEnteredPacket",
  "Name": "GameServerEntered",
  "Code": 241,
  "SubCode": 0,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MagicEffectStatusPacket",
  "Name": "MagicEffectStatus",
  "Code": 7,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "WeatherStatusUpdatePacket",
  "Name": "WeatherStatusUpdate",
  "Code": 15,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "AddCharactersToScopePacket",
  "Name": "AddCharactersToScope",
  "Code": 18,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AddCharactersToScope075Packet",
  "Name": "AddCharactersToScope075",
  "Code": 18,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AddCharactersToScope095Packet",
  "Name": "AddCharactersToScope095",
  "Code": 18,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AddNpcsToScopePacket",
  "Name": "AddNpcsToScope",
  "Code": 19,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AddNpcsToScope075Packet",
  "Name": "AddNpcsToScope075",
  "Code": 19,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AddNpcsToScope095Packet",
  "Name": "AddNpcsToScope095",
  "Code": 19,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AddSummonedMonstersToScopePacket",
  "Name": "AddSummonedMonstersToScope",
  "Code": 31,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AddSummonedMonstersToScope075Packet",
  "Name": "AddSummonedMonstersToScope075",
  "Code": 31,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AddSummonedMonstersToScope095Packet",
  "Name": "AddSummonedMonstersToScope095",
  "Code": 31,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "MapObjectOutOfScopePacket",
  "Name": "MapObjectOutOfScope",
  "Code": 20,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ObjectGotKilledPacket",
  "Name": "ObjectGotKilled",
  "Code": 23,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ObjectAnimationPacket",
  "Name": "ObjectAnimation",
  "Code": 24,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "AreaSkillAnimationPacket",
  "Name": "AreaSkillAnimation",
  "Code": 30,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "SkillAnimationPacket",
  "Name": "SkillAnimation",
  "Code": 25,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "AreaSkillAnimation075Packet",
  "Name": "AreaSkillAnimation075",
  "Code": 30,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "AreaSkillAnimation095Packet",
  "Name": "AreaSkillAnimation095",
  "Code": 30,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "SkillAnimation075Packet",
  "Name": "SkillAnimation075",
  "Code": 25,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "SkillAnimation095Packet",
  "Name": "SkillAnimation095",
  "Code": 25,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "MagicEffectCancelledPacket",
  "Name": "MagicEffectCancelled",
  "Code": 27,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "MagicEffectCancelled075Packet",
  "Name": "MagicEffectCancelled075",
  "Code": 27,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "RageAttackPacket",
  "Name": "RageAttack",
  "Code": 74,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "RageAttackRangeResponsePacket",
  "Name": "RageAttackRangeResponse",
  "Code": 75,
  "SubCode": null,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "AppearanceChangedPacket",
  "Name": "AppearanceChanged",
  "Code": 37,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ObjectMessagePacket",
  "Name": "ObjectMessage",
  "Code": 1,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "PartyRequestPacket",
  "Name": "PartyRequest",
  "Code": 64,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "PartyListPacket",
  "Name": "PartyList",
  "Code": 66,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "PartyList075Packet",
  "Name": "PartyList075",
  "Code": 66,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "RemovePartyMemberPacket",
  "Name": "RemovePartyMember",
  "Code": 67,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "PartyHealthUpdatePacket",
  "Name": "PartyHealthUpdate",
  "Code": 68,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "PlayerShopOpenSuccessfulPacket",
  "Name": "PlayerShopOpenSuccessful",
  "Code": 63,
  "SubCode": 2,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "TradeButtonStateChangedPacket",
  "Name": "TradeButtonStateChanged",
  "Code": 195,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "TradeMoneySetResponsePacket",
  "Name": "TradeMoneySetResponse",
  "Code": 58,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "TradeMoneyUpdatePacket",
  "Name": "TradeMoneyUpdate",
  "Code": 59,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "TradeRequestAnswerPacket",
  "Name": "TradeRequestAnswer",
  "Code": 55,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "TradeRequestPacket",
  "Name": "TradeRequest",
  "Code": 54,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "TradeFinishedPacket",
  "Name": "TradeFinished",
  "Code": 61,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "TradeItemAddedPacket",
  "Name": "TradeItemAdded",
  "Code": 57,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "TradeItemRemovedPacket",
  "Name": "TradeItemRemoved",
  "Code": 56,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "LoginResponsePacket",
  "Name": "LoginResponse",
  "Code": 241,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "LogoutResponsePacket",
  "Name": "LogoutResponse",
  "Code": 241,
  "SubCode": 2,
  "HeaderType": "C3HeaderWithSubCode"
 },
 {
  "name": "ChatMessagePacket",
  "Name": "ChatMessage",
  "Code": 0,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ObjectHitPacket",
  "Name": "ObjectHit",
  "Code": 17,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ObjectMovedPacket",
  "Name": "ObjectMoved",
  "Code": 21,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ObjectWalkedPacket",
  "Name": "ObjectWalked",
  "Code": 212,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ObjectWalked075Packet",
  "Name": "ObjectWalked075",
  "Code": 16,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ExperienceGainedPacket",
  "Name": "ExperienceGained",
  "Code": 22,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "MapChangedPacket",
  "Name": "MapChanged",
  "Code": 28,
  "SubCode": 15,
  "HeaderType": "C3HeaderWithSubCode"
 },
 {
  "name": "MapChanged075Packet",
  "Name": "MapChanged075",
  "Code": 28,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "ApplyKeyConfigurationPacket",
  "Name": "ApplyKeyConfiguration",
  "Code": 243,
  "SubCode": 48,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ItemsDroppedPacket",
  "Name": "ItemsDropped",
  "Code": 32,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "MoneyDroppedPacket",
  "Name": "MoneyDropped",
  "Code": 32,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "MoneyDropped075Packet",
  "Name": "MoneyDropped075",
  "Code": 32,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "ItemDropRemovedPacket",
  "Name": "ItemDropRemoved",
  "Code": 33,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "ItemAddedToInventoryPacket",
  "Name": "ItemAddedToInventory",
  "Code": 34,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "ItemDropResponsePacket",
  "Name": "ItemDropResponse",
  "Code": 35,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ItemPickUpRequestFailedPacket",
  "Name": "ItemPickUpRequestFailed",
  "Code": 34,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "InventoryMoneyUpdatePacket",
  "Name": "InventoryMoneyUpdate",
  "Code": 34,
  "SubCode": 254,
  "HeaderType": "C3HeaderWithSubCode"
 },
 {
  "name": "ItemMovedPacket",
  "Name": "ItemMoved",
  "Code": 36,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "ItemMoveRequestFailedPacket",
  "Name": "ItemMoveRequestFailed",
  "Code": 36,
  "SubCode": 255,
  "HeaderType": "C3HeaderWithSubCode"
 },
 {
  "name": "CurrentHealthAndShieldPacket",
  "Name": "CurrentHealthAndShield",
  "Code": 38,
  "SubCode": 255,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MaximumHealthAndShieldPacket",
  "Name": "MaximumHealthAndShield",
  "Code": 38,
  "SubCode": 254,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ItemConsumptionFailedPacket",
  "Name": "ItemConsumptionFailed",
  "Code": 38,
  "SubCode": 253,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CurrentManaAndAbilityPacket",
  "Name": "CurrentManaAndAbility",
  "Code": 39,
  "SubCode": 255,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MaximumManaAndAbilityPacket",
  "Name": "MaximumManaAndAbility",
  "Code": 39,
  "SubCode": 254,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ItemRemovedPacket",
  "Name": "ItemRemoved",
  "Code": 40,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ConsumeItemWithEffectPacket",
  "Name": "ConsumeItemWithEffect",
  "Code": 41,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "ItemDurabilityChangedPacket",
  "Name": "ItemDurabilityChanged",
  "Code": 42,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "FruitConsumptionResponsePacket",
  "Name": "FruitConsumptionResponse",
  "Code": 44,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "EffectItemConsumptionPacket",
  "Name": "EffectItemConsumption",
  "Code": 45,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "NpcWindowResponsePacket",
  "Name": "NpcWindowResponse",
  "Code": 48,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "StoreItemListPacket",
  "Name": "StoreItemList",
  "Code": 49,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "NpcItemBuyFailedPacket",
  "Name": "NpcItemBuyFailed",
  "Code": 50,
  "SubCode": 255,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ItemBoughtPacket",
  "Name": "ItemBought",
  "Code": 50,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "NpcItemSellResultPacket",
  "Name": "NpcItemSellResult",
  "Code": 51,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "PlayerShopSetItemPriceResponsePacket",
  "Name": "PlayerShopSetItemPriceResponse",
  "Code": 63,
  "SubCode": 1,
  "HeaderType": "C3HeaderWithSubCode"
 },
 {
  "name": "PlayerShopClosedPacket",
  "Name": "PlayerShopClosed",
  "Code": 63,
  "SubCode": 3,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "PlayerShopItemSoldToPlayerPacket",
  "Name": "PlayerShopItemSoldToPlayer",
  "Code": 63,
  "SubCode": 8,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ClosePlayerShopDialogPacket",
  "Name": "ClosePlayerShopDialog",
  "Code": 63,
  "SubCode": 18,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "PlayerShopItemListPacket",
  "Name": "PlayerShopItemList",
  "Code": 63,
  "SubCode": 5,
  "HeaderType": "C2HeaderWithSubCode"
 },
 {
  "name": "PlayerShopsPacket",
  "Name": "PlayerShops",
  "Code": 63,
  "SubCode": 0,
  "HeaderType": "C2HeaderWithSubCode"
 },
 {
  "name": "AddTransformedCharactersToScope075Packet",
  "Name": "AddTransformedCharactersToScope075",
  "Code": 69,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AddTransformedCharactersToScopePacket",
  "Name": "AddTransformedCharactersToScope",
  "Code": 69,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "ChangeTerrainAttributesPacket",
  "Name": "ChangeTerrainAttributes",
  "Code": 70,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ShowEffectPacket",
  "Name": "ShowEffect",
  "Code": 72,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "CharacterListPacket",
  "Name": "CharacterList",
  "Code": 243,
  "SubCode": 0,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterClassCreationUnlockPacket",
  "Name": "CharacterClassCreationUnlock",
  "Code": 222,
  "SubCode": 0,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterList075Packet",
  "Name": "CharacterList075",
  "Code": 243,
  "SubCode": 0,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterList095Packet",
  "Name": "CharacterList095",
  "Code": 243,
  "SubCode": 0,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterCreationSuccessfulPacket",
  "Name": "CharacterCreationSuccessful",
  "Code": 243,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterCreationFailedPacket",
  "Name": "CharacterCreationFailed",
  "Code": 243,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "RespawnAfterDeath075Packet",
  "Name": "RespawnAfterDeath075",
  "Code": 243,
  "SubCode": 4,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "RespawnAfterDeath095Packet",
  "Name": "RespawnAfterDeath095",
  "Code": 243,
  "SubCode": 4,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "PoisonDamagePacket",
  "Name": "PoisonDamage",
  "Code": 243,
  "SubCode": 7,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "HeroStateChangedPacket",
  "Name": "HeroStateChanged",
  "Code": 243,
  "SubCode": 8,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SkillAddedPacket",
  "Name": "SkillAdded",
  "Code": 243,
  "SubCode": 17,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SkillRemovedPacket",
  "Name": "SkillRemoved",
  "Code": 243,
  "SubCode": 17,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SkillListUpdatePacket",
  "Name": "SkillListUpdate",
  "Code": 243,
  "SubCode": 17,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SkillAdded075Packet",
  "Name": "SkillAdded075",
  "Code": 243,
  "SubCode": 17,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SkillRemoved075Packet",
  "Name": "SkillRemoved075",
  "Code": 243,
  "SubCode": 17,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SkillAdded095Packet",
  "Name": "SkillAdded095",
  "Code": 243,
  "SubCode": 17,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SkillRemoved095Packet",
  "Name": "SkillRemoved095",
  "Code": 243,
  "SubCode": 17,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SkillListUpdate075Packet",
  "Name": "SkillListUpdate075",
  "Code": 243,
  "SubCode": 17,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterFocusedPacket",
  "Name": "CharacterFocused",
  "Code": 243,
  "SubCode": 21,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterStatIncreaseResponsePacket",
  "Name": "CharacterStatIncreaseResponse",
  "Code": 243,
  "SubCode": 6,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterDeleteResponsePacket",
  "Name": "CharacterDeleteResponse",
  "Code": 243,
  "SubCode": 2,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterLevelUpdatePacket",
  "Name": "CharacterLevelUpdate",
  "Code": 243,
  "SubCode": 5,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "CharacterInformationPacket",
  "Name": "CharacterInformation",
  "Code": 243,
  "SubCode": 3,
  "HeaderType": "C3HeaderWithSubCode"
 },
 {
  "name": "CharacterInformation075Packet",
  "Name": "CharacterInformation075",
  "Code": 243,
  "SubCode": 3,
  "HeaderType": "C3HeaderWithSubCode"
 },
 {
  "name": "CharacterInformation097Packet",
  "Name": "CharacterInformation097",
  "Code": 243,
  "SubCode": 3,
  "HeaderType": "C3HeaderWithSubCode"
 },
 {
  "name": "CharacterInventoryPacket",
  "Name": "CharacterInventory",
  "Code": 243,
  "SubCode": 16,
  "HeaderType": "C4HeaderWithSubCode"
 },
 {
  "name": "InventoryItemUpgradedPacket",
  "Name": "InventoryItemUpgraded",
  "Code": 243,
  "SubCode": 20,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SummonHealthUpdatePacket",
  "Name": "SummonHealthUpdate",
  "Code": 243,
  "SubCode": 32,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "GuildSoccerTimeUpdatePacket",
  "Name": "GuildSoccerTimeUpdate",
  "Code": 243,
  "SubCode": 34,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "GuildSoccerScoreUpdatePacket",
  "Name": "GuildSoccerScoreUpdate",
  "Code": 243,
  "SubCode": 35,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ServerCommandPacket",
  "Name": "ServerCommand",
  "Code": 243,
  "SubCode": 64,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ShowFireworksPacket",
  "Name": "ShowFireworks",
  "Code": 243,
  "SubCode": 64,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ShowChristmasFireworksPacket",
  "Name": "ShowChristmasFireworks",
  "Code": 243,
  "SubCode": 64,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "PlayFanfareSoundPacket",
  "Name": "PlayFanfareSound",
  "Code": 243,
  "SubCode": 64,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ShowSwirlPacket",
  "Name": "ShowSwirl",
  "Code": 243,
  "SubCode": 64,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MasterStatsUpdatePacket",
  "Name": "MasterStatsUpdate",
  "Code": 243,
  "SubCode": 80,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MasterCharacterLevelUpdatePacket",
  "Name": "MasterCharacterLevelUpdate",
  "Code": 243,
  "SubCode": 81,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MasterSkillLevelUpdatePacket",
  "Name": "MasterSkillLevelUpdate",
  "Code": 243,
  "SubCode": 82,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MasterSkillListPacket",
  "Name": "MasterSkillList",
  "Code": 243,
  "SubCode": 83,
  "HeaderType": "C2HeaderWithSubCode"
 },
 {
  "name": "ServerMessagePacket",
  "Name": "ServerMessage",
  "Code": 13,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildJoinRequestPacket",
  "Name": "GuildJoinRequest",
  "Code": 80,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildJoinResponsePacket",
  "Name": "GuildJoinResponse",
  "Code": 81,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildListPacket",
  "Name": "GuildList",
  "Code": 82,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "GuildList075Packet",
  "Name": "GuildList075",
  "Code": 82,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "GuildKickResponsePacket",
  "Name": "GuildKickResponse",
  "Code": 83,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ShowGuildMasterDialogPacket",
  "Name": "ShowGuildMasterDialog",
  "Code": 84,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ShowGuildCreationDialogPacket",
  "Name": "ShowGuildCreationDialog",
  "Code": 85,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildCreationResultPacket",
  "Name": "GuildCreationResult",
  "Code": 86,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildMemberLeftGuildPacket",
  "Name": "GuildMemberLeftGuild",
  "Code": 93,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildWarRequestResultPacket",
  "Name": "GuildWarRequestResult",
  "Code": 96,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildWarRequestPacket",
  "Name": "GuildWarRequest",
  "Code": 97,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildWarDeclaredPacket",
  "Name": "GuildWarDeclared",
  "Code": 98,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildWarEndedPacket",
  "Name": "GuildWarEnded",
  "Code": 99,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildWarScoreUpdatePacket",
  "Name": "GuildWarScoreUpdate",
  "Code": 100,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "AssignCharacterToGuildPacket",
  "Name": "AssignCharacterToGuild",
  "Code": 101,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "AssignCharacterToGuild075Packet",
  "Name": "AssignCharacterToGuild075",
  "Code": 91,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "GuildInformationPacket",
  "Name": "GuildInformation",
  "Code": 102,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "GuildInformations075Packet",
  "Name": "GuildInformations075",
  "Code": 90,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "SingleGuildInformation075Packet",
  "Name": "SingleGuildInformation075",
  "Code": 92,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "VaultMoneyUpdatePacket",
  "Name": "VaultMoneyUpdate",
  "Code": 129,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "VaultClosedPacket",
  "Name": "VaultClosed",
  "Code": 130,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "VaultProtectionInformationPacket",
  "Name": "VaultProtectionInformation",
  "Code": 131,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ItemCraftingResultPacket",
  "Name": "ItemCraftingResult",
  "Code": 134,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "CraftingDialogClosed075Packet",
  "Name": "CraftingDialogClosed075",
  "Code": 135,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "LegacyQuestStateListPacket",
  "Name": "LegacyQuestStateList",
  "Code": 160,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "LegacyQuestStateDialogPacket",
  "Name": "LegacyQuestStateDialog",
  "Code": 161,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "LegacySetQuestStateResponsePacket",
  "Name": "LegacySetQuestStateResponse",
  "Code": 162,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "LegacyQuestRewardPacket",
  "Name": "LegacyQuestReward",
  "Code": 163,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "LegacyQuestMonsterKillInfoPacket",
  "Name": "LegacyQuestMonsterKillInfo",
  "Code": 164,
  "SubCode": 0,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "PetModePacket",
  "Name": "PetMode",
  "Code": 167,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "PetAttackPacket",
  "Name": "PetAttack",
  "Code": 168,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "PetInfoResponsePacket",
  "Name": "PetInfoResponse",
  "Code": 169,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "DuelStartResultPacket",
  "Name": "DuelStartResult",
  "Code": 170,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelStartRequestPacket",
  "Name": "DuelStartRequest",
  "Code": 170,
  "SubCode": 2,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelEndPacket",
  "Name": "DuelEnd",
  "Code": 170,
  "SubCode": 3,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelScorePacket",
  "Name": "DuelScore",
  "Code": 170,
  "SubCode": 4,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelHealthUpdatePacket",
  "Name": "DuelHealthUpdate",
  "Code": 170,
  "SubCode": 5,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelStatusPacket",
  "Name": "DuelStatus",
  "Code": 170,
  "SubCode": 6,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelInitPacket",
  "Name": "DuelInit",
  "Code": 170,
  "SubCode": 7,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelHealthBarInitPacket",
  "Name": "DuelHealthBarInit",
  "Code": 170,
  "SubCode": 13,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelSpectatorAddedPacket",
  "Name": "DuelSpectatorAdded",
  "Code": 170,
  "SubCode": 8,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelSpectatorRemovedPacket",
  "Name": "DuelSpectatorRemoved",
  "Code": 170,
  "SubCode": 10,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelSpectatorListPacket",
  "Name": "DuelSpectatorList",
  "Code": 170,
  "SubCode": 11,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "DuelFinishedPacket",
  "Name": "DuelFinished",
  "Code": 170,
  "SubCode": 12,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "SkillStageUpdatePacket",
  "Name": "SkillStageUpdate",
  "Code": 186,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "IllusionTempleEnterResultPacket",
  "Name": "IllusionTempleEnterResult",
  "Code": 191,
  "SubCode": 0,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "IllusionTempleStatePacket",
  "Name": "IllusionTempleState",
  "Code": 191,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "IllusionTempleSkillUsageResultPacket",
  "Name": "IllusionTempleSkillUsageResult",
  "Code": 191,
  "SubCode": 2,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "IllusionTempleUserCountPacket",
  "Name": "IllusionTempleUserCount",
  "Code": 191,
  "SubCode": 3,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "IllusionTempleResultPacket",
  "Name": "IllusionTempleResult",
  "Code": 191,
  "SubCode": 4,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "IllusionTempleSkillPointUpdatePacket",
  "Name": "IllusionTempleSkillPointUpdate",
  "Code": 191,
  "SubCode": 6,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "IllusionTempleSkillEndedPacket",
  "Name": "IllusionTempleSkillEnded",
  "Code": 191,
  "SubCode": 7,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "IllusionTempleHolyItemRelicsPacket",
  "Name": "IllusionTempleHolyItemRelics",
  "Code": 191,
  "SubCode": 8,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "IllusionTempleSkillEndPacket",
  "Name": "IllusionTempleSkillEnd",
  "Code": 191,
  "SubCode": 7,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "ChainLightningHitInfoPacket",
  "Name": "ChainLightningHitInfo",
  "Code": 191,
  "SubCode": 10,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MuHelperStatusUpdatePacket",
  "Name": "MuHelperStatusUpdate",
  "Code": 191,
  "SubCode": 81,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MuHelperConfigurationDataPacket",
  "Name": "MuHelperConfigurationData",
  "Code": 174,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "MessengerInitializationPacket",
  "Name": "MessengerInitialization",
  "Code": 192,
  "SubCode": null,
  "HeaderType": "C2Header"
 },
 {
  "name": "FriendAddedPacket",
  "Name": "FriendAdded",
  "Code": 193,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "FriendRequestPacket",
  "Name": "FriendRequest",
  "Code": 194,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "FriendDeletedPacket",
  "Name": "FriendDeleted",
  "Code": 195,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "FriendOnlineStateUpdatePacket",
  "Name": "FriendOnlineStateUpdate",
  "Code": 196,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "LetterSendResponsePacket",
  "Name": "LetterSendResponse",
  "Code": 197,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "AddLetterPacket",
  "Name": "AddLetter",
  "Code": 198,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "OpenLetterPacket",
  "Name": "OpenLetter",
  "Code": 199,
  "SubCode": null,
  "HeaderType": "C4Header"
 },
 {
  "name": "RemoveLetterPacket",
  "Name": "RemoveLetter",
  "Code": 200,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ChatRoomConnectionInfoPacket",
  "Name": "ChatRoomConnectionInfo",
  "Code": 202,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "FriendInvitationResultPacket",
  "Name": "FriendInvitationResult",
  "Code": 203,
  "SubCode": null,
  "HeaderType": "C3Header"
 },
 {
  "name": "QuestEventResponsePacket",
  "Name": "QuestEventResponse",
  "Code": 246,
  "SubCode": 3,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "AvailableQuestsPacket",
  "Name": "AvailableQuests",
  "Code": 246,
  "SubCode": 10,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "QuestStepInfoPacket",
  "Name": "QuestStepInfo",
  "Code": 246,
  "SubCode": 11,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "QuestProgressPacket",
  "Name": "QuestProgress",
  "Code": 246,
  "SubCode": 12,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "QuestCompletionResponsePacket",
  "Name": "QuestCompletionResponse",
  "Code": 246,
  "SubCode": 13,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "QuestCancelledPacket",
  "Name": "QuestCancelled",
  "Code": 246,
  "SubCode": 15,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "QuestStateListPacket",
  "Name": "QuestStateList",
  "Code": 246,
  "SubCode": 26,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "QuestStatePacket",
  "Name": "QuestState",
  "Code": 246,
  "SubCode": 27,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "OpenNpcDialogPacket",
  "Name": "OpenNpcDialog",
  "Code": 249,
  "SubCode": 1,
  "HeaderType": "C3HeaderWithSubCode"
 },
 {
  "name": "DevilSquareEnterResultPacket",
  "Name": "DevilSquareEnterResult",
  "Code": 144,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "MiniGameOpeningStatePacket",
  "Name": "MiniGameOpeningState",
  "Code": 145,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "UpdateMiniGameStatePacket",
  "Name": "UpdateMiniGameState",
  "Code": 146,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "MiniGameScoreTablePacket",
  "Name": "MiniGameScoreTable",
  "Code": 147,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "BloodCastleScorePacket",
  "Name": "BloodCastleScore",
  "Code": 147,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "BloodCastleEnterResultPacket",
  "Name": "BloodCastleEnterResult",
  "Code": 154,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "BloodCastleStatePacket",
  "Name": "BloodCastleState",
  "Code": 155,
  "SubCode": null,
  "HeaderType": "C1Header"
 },
 {
  "name": "ChaosCastleEnterResultPacket",
  "Name": "ChaosCastleEnterResult",
  "Code": 175,
  "SubCode": 1,
  "HeaderType": "C1HeaderWithSubCode"
 },
 {
  "name": "MapEventStatePacket",
  "Name": "MapEventState",
  "Code": 11,
  "SubCode": null,
  "HeaderType": "C1Header"
 }
];
