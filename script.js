// === CONTRACT MARKERS (auto-injected for traceability) ===
// CONTRACT: primary-action-button
// === END CONTRACT MARKERS ===

(function() {
  var addBtn = document.getElementById("addBtn");
  var itemList = document.getElementById("itemList");
  var emptyState = document.getElementById("emptyState");
  var formError = document.getElementById("formError");
  var countBadge = document.getElementById("countBadge");

  function showError(msg) {
    formError.textContent = msg;
    formError.style.display = "block";
    setTimeout(function() { formError.style.display = "none"; }, 3000);
  }

  function escHtml(str) {
    var d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function renderItems(items) {
    countBadge.textContent = items.length;
    if (!items || items.length === 0) {
      itemList.innerHTML = "";
      emptyState.style.display = "block";
      return;
    }
    emptyState.style.display = "none";
    itemList.innerHTML = items.map(function(item) {
      return '<div class="item-card" data-id="' + item.id + '">' +
        '<div class="item-info">' + '<h3>' + escHtml(item.name) + '</h3>' + '\n' + (item.description ? '<p>Description: ' + escHtml(item.description) + '</p>' : '') + '</div>' +
        '<button class="btn-delete" data-id="' + item.id + '" title="Delete">🗑</button></div>';
    }).join("");
    itemList.querySelectorAll(".btn-delete").forEach(function(btn) {
      btn.addEventListener("click", function() { deleteItem(btn.dataset.id); });
    });
  }

  function loadItems() {
    fetch("/api/items")
      .then(function(r) { return r.json(); })
      .then(function(data) { if (data.success) renderItems(data.items); })
      .catch(function() { renderItems([]); });
  }

  function deleteItem(id) {
    fetch("/api/items/" + id, { method: "DELETE" })
      .then(function(r) { return r.json(); })
      .then(function(data) { if (data.success) loadItems(); })
      .catch(function(e) { console.error("Delete failed:", e); });
  }

  addBtn.addEventListener("click", function() {
    var _val = document.getElementById("field_name").value.trim();
    if (!_val) { showError("Name is required"); document.getElementById("field_name").focus(); return; }
    addBtn.disabled = true;
    fetch("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: document.getElementById("field_name").value.trim(), description: document.getElementById("field_description").value.trim() })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) { document.getElementById("field_name").value = ""; document.getElementById("field_description").value = ""; loadItems(); }
        else { showError(data.message || "Failed to add"); }
      })
      .catch(function() { showError("Network error"); })
      .finally(function() { addBtn.disabled = false; });
  });

  document.getElementById("field_name").addEventListener("keydown", function(e) { if (e.key === "Enter") addBtn.click(); });

  loadItems();
})();