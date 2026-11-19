ITEMS = [
    {"id": "nb-blue-01", "name": "Blue Notebook", "price": 4.50, "stock": 12},
    {"id": "nb-red-01", "name": "Red Notebook", "price": 4.50, "stock": 0},
    {"id": "pen-blk-01", "name": "Black Pen", "price": 1.20, "stock": 40},
]


class Catalog:
    def search(self, query):
        words = query.lower().split()
        return [dict(i) for i in ITEMS if all(w in i["name"].lower() for w in words)]

    def stock(self, item_id):
        return next((i["stock"] for i in ITEMS if i["id"] == item_id), 0)
