import "./test-env";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { it } from "node:test";

it("native Telegram QA preserves current TDLib forum topics on receive and send", () => {
  const actual = execFileSync("python3", ["-c", `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("driver", "scripts/e2e/telegram-user-driver.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Client:
    def request(self, payload, timeout):
        self.payload = payload
        return {"id": 99}
driver = object.__new__(module.UserDriver)
driver.client = Client()
driver.send_text(-1001, "QA command", reply_to=77, thread_id=13832)
current = module.normalize_message({"id":99, "message_thread_id":0,
    "topic_id":{"@type":"messageTopicForum", "forum_topic_id":13832},
    "reply_to":{"@type":"messageReplyToMessage", "message_id":77}})
legacy = module.normalize_message({"id":98, "message_thread_id":13831})
driver.send_text(-1001, "General chat")
print(json.dumps({"current":current, "legacy":legacy, "general":driver.client.payload,
    "topicHistory":module.message_history_request(-1001, 30, 13832),
    "chatHistory":module.message_history_request(-1001, 30)}))
driver.send_text(-1001, "QA command", reply_to=77, thread_id=13832)
print(json.dumps(driver.client.payload))
`], { encoding: "utf8" }).trim().split("\n").map((line) => JSON.parse(line));
  // The driver sends a typed MessageTopic, rather than dropping the command in General.
  assert.equal(actual[0].current.threadId, 13832);
  assert.equal(actual[0].current.replyToMessageId, 77);
  assert.equal(actual[0].legacy.threadId, 13831);
  assert.equal(actual[0].general.topic_id, null);
  assert.equal(actual[0].general.reply_to, null);
  assert.deepEqual(actual[0].topicHistory, { "@type": "getForumTopicHistory", chat_id: -1001,
    forum_topic_id: 13832, from_message_id: 0, offset: 0, limit: 30 });
  assert.equal(actual[0].chatHistory["@type"], "getChatHistory");
  assert.equal(actual[0].chatHistory.only_local, false);
  assert.deepEqual(actual[1].topic_id, { "@type": "messageTopicForum", forum_topic_id: 13832 });
  assert.deepEqual(actual[1].reply_to, { "@type": "inputMessageReplyToMessage", message_id: 77 });
});
