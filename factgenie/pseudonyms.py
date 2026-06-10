ANNOTATOR_PSEUDONYM_CITIES = [
    "Tokyo",
    "Paris",
    "London",
    "New York",
    "Sydney",
    "Berlin",
    "Rome",
    "Cairo",
    "Mumbai",
    "Mexico City",
    "Prague",
    "Barcelona",
    "Toronto",
    "Seoul",
    "Cape Town",
    "Buenos Aires",
    "Vienna",
    "Lisbon",
    "Singapore",
    "Amsterdam",
    "Brno",
    "Ostrava",
    "Plzen",
    "Olomouc",
    "Liberec",
    "Trebon",
    "Pardubice",
    "Zlin",
    "Telc",
    "Jihlava"
]


def city_alias_from_index(index):
    if index < 0:
        index = 0
    base_index = index % len(ANNOTATOR_PSEUDONYM_CITIES)
    suffix_index = (index // len(ANNOTATOR_PSEUDONYM_CITIES)) + 1
    alias = ANNOTATOR_PSEUDONYM_CITIES[base_index]
    if suffix_index > 1:
        alias = f"{alias} {suffix_index}"
    return alias


def next_available_city_alias(used_aliases):
    index = 0
    while True:
        alias = city_alias_from_index(index)
        if alias not in used_aliases:
            return alias
        index += 1
